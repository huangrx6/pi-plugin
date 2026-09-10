/**
 * plan-approval-dialog.test.js — 审批对话框覆盖(0.41.0)。
 *
 *   A. 规范短语对 resolvePlanResponse 锚定:Execute 短语必须解析为
 *      approve、Cancel 短语必须解析为 cancel(换词会掉进 revise,
 *      "批准"按钮反而退回规划——此回归曾用真机才暴露,现在锁死)。
 *   B. 三个分支的派发行为;Esc(undefined)/空 refine 不发消息。
 *   C. 跳过条件:配置关闭、无 UI、无 ui.select。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolvePlanResponse } from "../src/core/approval.js";
import {
	APPROVE_PHRASE,
	CANCEL_PHRASE,
	isPlanModeActive,
	offerPlanApprovalDialog,
} from "../extensions/policy-engine/plan-approval-dialog.js";

function captureUi(choice, editorText = "改成两步") {
	const sent = [];
	const calls = [];
	const ctx = {
		hasUI: true,
		ui: {
			select: async (...args) => {
				calls.push({ method: "select", args });
				return choice;
			},
			editor: async (...args) => {
				calls.push({ method: "editor", args });
				return editorText;
			},
		},
	};
	const pi = {
		sendUserMessage: async (text, options) => {
			sent.push({ text, options });
		},
	};
	return { ctx, pi, sent, calls };
}

describe("approval phrase anchoring", () => {
	it("APPROVE_PHRASE resolves to approve (never revise)", () => {
		assert.equal(resolvePlanResponse(APPROVE_PHRASE).verdict, "approve");
	});
	it("CANCEL_PHRASE resolves to cancel", () => {
		assert.equal(resolvePlanResponse(CANCEL_PHRASE).verdict, "cancel");
	});
});

describe("offerPlanApprovalDialog", () => {
	it("Execute sends the anchored approval phrase with followUp delivery", async () => {
		const { ctx, pi, sent } = captureUi("Execute the plan");
		await offerPlanApprovalDialog(pi, ctx, {});
		assert.equal(sent.length, 1);
		assert.equal(sent[0].text, APPROVE_PHRASE);
		assert.equal(sent[0].options.deliverAs, "followUp");
	});

	it("Cancel sends the anchored cancel phrase", async () => {
		const { ctx, pi, sent } = captureUi("Cancel");
		await offerPlanApprovalDialog(pi, ctx, {});
		assert.deepEqual(
			sent.map((s) => s.text),
			[CANCEL_PHRASE],
		);
	});

	it("Refine opens the editor and forwards nonempty text", async () => {
		const { ctx, pi, sent, calls } = captureUi(
			"Refine the plan",
			"再加一步回滚验证",
		);
		await offerPlanApprovalDialog(pi, ctx, {});
		assert.equal(calls.at(-1).method, "editor");
		assert.deepEqual(
			sent.map((s) => s.text),
			["再加一步回滚验证"],
		);
	});

	it("empty refinement sends nothing", async () => {
		const { ctx, pi, sent } = captureUi("Refine the plan", "   ");
		await offerPlanApprovalDialog(pi, ctx, {});
		assert.equal(sent.length, 0);
	});

	it("escape / undefined choice sends nothing", async () => {
		const { ctx, pi, sent } = captureUi(undefined);
		await offerPlanApprovalDialog(pi, ctx, {});
		assert.equal(sent.length, 0);
	});

	it("skips silently when the dialog is disabled in config", async () => {
		const { ctx, pi, sent, calls } = captureUi("Execute the plan");
		await offerPlanApprovalDialog(pi, ctx, { planApprovalDialog: false });
		assert.equal(sent.length, 0);
		assert.equal(calls.length, 0);
	});

	it("skips silently on non-interactive hosts", async () => {
		const sent = [];
		const pi = { sendUserMessage: async (text) => sent.push(text) };
		await offerPlanApprovalDialog(pi, { hasUI: false, ui: {} }, {});
		await offerPlanApprovalDialog(pi, { hasUI: true, ui: {} }, {});
		await offerPlanApprovalDialog(pi, undefined, {});
		assert.equal(sent.length, 0);
	});
});

describe("isPlanModeActive (0.42.0 plan-mode mutex probe)", () => {
  it("returns false when pi has no getAllTools / getCommands", () => {
    assert.equal(isPlanModeActive({}), false);
    assert.equal(isPlanModeActive(null), false);
    assert.equal(isPlanModeActive(undefined), false);
  });

  it("returns false when no plan-related extension found", () => {
    const pi = {
      getAllTools: () => [
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "bash", sourceInfo: { source: "builtin" } },
        { name: "edit", sourceInfo: { source: "builtin" } },
      ],
      getCommands: () => [
        { name: "policy", sourceInfo: { source: "extension" } },
      ],
    };
    assert.equal(isPlanModeActive(pi), false);
  });

  it("returns true when an extension tool with 'plan' in name is registered", () => {
    const pi = {
      getAllTools: () => [
        { name: "plan", sourceInfo: { source: "extension" } },
      ],
      getCommands: () => [],
    };
    assert.equal(isPlanModeActive(pi), true);
  });

  it("returns true when a 'plan' command from extension is registered", () => {
    const pi = {
      getAllTools: () => [],
      getCommands: () => [
        { name: "plan", sourceInfo: { source: "extension" } },
      ],
    };
    assert.equal(isPlanModeActive(pi), true);
  });

  it("ignores plan-keyword in builtin / sdk tools (only extension source counts)", () => {
    const pi = {
      getAllTools: () => [
        { name: "plan", sourceInfo: { source: "builtin" } }, // not extension
        { name: "plan", sourceInfo: { source: "sdk" } }, // not extension
        { name: "plan", sourceInfo: undefined }, // unknown
      ],
      getCommands: () => [
        { name: "plan", sourceInfo: { source: "builtin" } },
      ],
    };
    assert.equal(isPlanModeActive(pi), false);
  });

  it("probe exceptions fall back to false (conservative — prefer double dialog over false surrender)", () => {
    const pi = {
      getAllTools: () => { throw new Error("probe failed"); },
      getCommands: () => [],
    };
    assert.equal(isPlanModeActive(pi), false);
  });
});

describe("offerPlanApprovalDialog: plan-mode mutex (0.42.0)", () => {
  function captureDialog(planModeActive) {
    const sent = [];
    const selectCalls = [];
    const notices = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title) => {
          selectCalls.push(title);
          return "Execute the plan";
        },
        editor: async () => "irrelevant",
        notify(message, level) {
          notices.push({ message, level });
        },
      },
    };
    const pi = {
      sendUserMessage: async (text, options) => {
        sent.push({ text, options });
      },
      getAllTools: () =>
        planModeActive
          ? [{ name: "plan", sourceInfo: { source: "extension" } }]
          : [],
      getCommands: () => [],
    };
    return { ctx, pi, sent, selectCalls, notices };
  }

  it("skips dialog and notifies when plan-mode is detected", async () => {
    const { ctx, pi, sent, selectCalls, notices } = captureDialog(true);
    await offerPlanApprovalDialog(pi, ctx, {});
    assert.equal(selectCalls.length, 0, "ui.select 不应被调用");
    assert.equal(sent.length, 0, "sendUserMessage 不应被调用");
    assert.equal(notices.length, 1, "应通知一次让位");
    assert.match(notices[0].message, /plan-mode/);
    assert.equal(notices[0].level, "info");
  });

  it("shows dialog normally when plan-mode is not detected", async () => {
    const { ctx, pi, sent, selectCalls, notices } = captureDialog(false);
    await offerPlanApprovalDialog(pi, ctx, {});
    assert.equal(selectCalls.length, 1, "ui.select 应被调用一次");
    assert.equal(sent.length, 1, "应发送执行短语");
    assert.equal(sent[0].text, APPROVE_PHRASE);
    assert.equal(notices.length, 0, "不通知让位");
  });
});
