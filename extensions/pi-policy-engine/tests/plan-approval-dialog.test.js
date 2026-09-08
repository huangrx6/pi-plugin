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
