import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_TYPE,
  activityRows,
  activitySnapshot,
  activityText,
  publishActivity,
  restoreActivity,
} from "../extensions/policy-engine/activity.js";
import { createCommandHandler } from "../extensions/policy-engine/commands.js";
import { notify } from "../extensions/policy-engine/helpers.js";
import {
  displayWidth,
  sanitizeTerminalText,
  wrapTerminalText,
} from "../extensions/policy-engine/terminal.js";

test("activity snapshots describe loaded policies and cannot drift with runtime state", () => {
  const decision = {
    rigor: "strict",
    taskType: "coding",
    risk: "high",
    loadedPolicies: ["rigor.strict-plan"],
    reasons: ["risk:high"],
    truncatedPolicies: ["domain.database"],
  };
  const snapshot = activitySnapshot(
    decision,
    "planning",
    "exact injected instructions",
  );
  decision.loadedPolicies.push("concern.production");
  assert.deepEqual(snapshot.decision.loadedPolicies, ["rigor.strict-plan"]);
  assert.match(activityText(snapshot), /先制定计划并等待审批/);
  assert.match(activityText(snapshot), /未注入：domain.database/);
  assert.equal(snapshot.injected, "exact injected instructions");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.decision));
});

test("only changed applied instructions produce transcript records", () => {
  const entries = [];
  const state = {
    lastDecision: { rigor: "quick", taskType: "documentation" },
    phase: "executing",
  };
  const pi = { appendEntry: (type, data) => entries.push({ type, data }) };
  publishActivity(pi, state, {}, "first");
  state.lastDecision.reasons = ["different classification wording"];
  publishActivity(pi, state, {}, "first");
  assert.equal(entries.length, 1);
  publishActivity(pi, state, {}, "changed constraints");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].data.injected, "first");
});

test("terminal text is control-safe and wraps by displayed grapheme width", () => {
  const unsafe = "\x1b[31m内容\x1b[0m\x1b]2;bad\x07\x1bPpayload\x1b\\\u202e";
  assert.equal(sanitizeTerminalText(unsafe), "内容");
  assert.deepEqual(wrapTerminalText("中文测试abcdef", 8), [
    "中文测试",
    "abcdef",
  ]);
  assert.deepEqual(wrapTerminalText("A👩‍💻e\u0301中", 4), ["A👩‍💻é", "中"]);
  assert.ok(
    wrapTerminalText("中文👩‍💻abc", 4).every((line) => displayWidth(line) <= 4),
  );
});

test("activity rows use theme roles for hierarchy and warnings", () => {
  const activity = activitySnapshot(
    {
      rigor: "strict",
      taskType: "coding",
      risk: "high",
      loadedPolicies: ["rigor.strict-plan"],
      truncatedPolicies: ["domain.database"],
    },
    "planning",
    "instructions",
  );
  const rows = activityRows(activity, true, 18);
  assert.equal(rows[0].tone, "accent");
  assert.ok(
    rows.some((row) => row.tone === "warning" && row.text.includes("预算不足")),
  );
  assert.ok(rows.every((row) => displayWidth(row.text) <= 18));
  assert.doesNotThrow(() => activityRows({}, true, 8));
});

test("all command notifications strip terminal control sequences", () => {
  const messages = [];
  notify(
    { ui: { notify: (message) => messages.push(message) } },
    "safe\x1b]2;title\x07\x1b[31m red\x1b[0m",
  );
  assert.equal(messages[0], "safe red");
});

test("single-level panel applies and saves the recommended preset", async () => {
  const state = {
    runtimeMode: null,
    runtimeRecognition: null,
    phase: "idle",
    lastActivity: { summary: "策略\x1b]2;bad\x07", injected: "" },
  };
  const selection =
    "自动处理（推荐）— 当前模型结合完整对话判断；选中后立即保存";
  const notifications = [];
  const titles = [];
  const saves = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
    saveConfig: async (value) => {
      saves.push(value);
      return "/agent/extensions-data/pi-policy-engine/config.json";
    },
  });
  await handler("", {
    ui: {
      select: async (title, options) => {
        titles.push(title);
        assert.ok(options.includes(selection));
        assert.ok(options.every((option) => option.includes("—")));
        return selection;
      },
      notify: (message) => notifications.push(message),
    },
  });
  assert.equal(state.runtimeMode, "auto");
  assert.deepEqual(state.runtimeRecognition, {
    enabled: true,
    source: "agent",
  });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].mode, "auto");
  assert.equal(saves[0].recognition.source, "agent");
  assert.match(notifications.at(-1), /已启用并保存/);
  assert.ok(titles.every((title) => !title.includes("\x1b")));
});

test("single-level panel exposes only everyday actions", async () => {
  const state = {
    runtimeMode: null,
    runtimeRecognition: null,
    phase: "idle",
    task: null,
    lastActivity: null,
  };
  const optionLists = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  await handler("", {
    ui: {
      select: async (_title, options) => {
        optionLists.push(options);
        return undefined;
      },
      notify() {},
    },
  });
  assert.equal(optionLists.length, 1);
  assert.equal(optionLists[0].length, 5);
  assert.ok(optionLists[0].some((option) => option.startsWith("自动处理")));
  assert.ok(optionLists[0].some((option) => option.startsWith("谨慎处理")));
  assert.ok(optionLists[0].some((option) => option.startsWith("检查配置")));
  assert.ok(optionLists[0].some((option) => option.startsWith("关闭策略")));
  assert.ok(
    optionLists[0].every((option) => !/单次模式|配置档|保存到/.test(option)),
  );
});

test("resuming restores the visible branch explanation and ignores malformed records", () => {
  const activity = activitySnapshot(
    { rigor: "quick", taskType: "documentation" },
    "executing",
    "instructions",
  );
  const entries = [
    { type: "custom", customType: ACTIVITY_TYPE, data: activity },
    { type: "custom", customType: ACTIVITY_TYPE, data: {} },
  ];
  const restored = restoreActivity(entries);
  assert.equal(restored.injected, "instructions");
  assert.notEqual(restored, activity);
  assert.ok(Object.isFrozen(restored));
  assert.equal(restoreActivity([]), null);
});
