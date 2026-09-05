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

test("interactive settings change one setting at a time", async () => {
  const state = {
    runtimeMode: null,
    runtimeProfile: null,
    runtimeRecognition: null,
    onceMode: null,
    phase: "idle",
    lastActivity: { summary: "策略\x1b]2;bad\x07", injected: "" },
  };
  const selections = [
    "设置与保存 — 调整模式、识别模型、配置档及持久化范围",
    "模式 — 当前 auto; 控制策略深度和审批流程",
    "quick — 快速检查、修改并验证",
  ];
  const notifications = [];
  const titles = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  await handler("", {
    ui: {
      select: async (title) => {
        titles.push(title);
        return selections.shift();
      },
      notify: (message) => notifications.push(message),
    },
  });
  assert.equal(state.runtimeMode, "quick");
  assert.equal(
    state.runtimeProfile,
    null,
    "changing mode must not force a profile prompt",
  );
  assert.match(notifications.at(-1), /策略模式已设为 quick/);
  assert.ok(titles.every((title) => !title.includes("\x1b")));
});

test("interactive recognition panel explains and applies the active agent model", async () => {
  const state = {
    runtimeMode: null,
    runtimeProfile: null,
    runtimeRecognition: null,
    onceMode: null,
    phase: "idle",
    task: null,
    lastActivity: null,
  };
  const selections = [
    "设置与保存 — 调整模式、识别模型、配置档及持久化范围",
    "意图识别 — 当前 off; 选择当前模型、独立接口或本地规则",
    "agent — 复用当前 agent 模型与认证；每个任务回合额外调用一次模型",
  ];
  const optionLists = [];
  const messages = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  await handler("", {
    ui: {
      select: async (_title, options) => {
        optionLists.push(options);
        return selections.shift();
      },
      notify: (message) => messages.push(message),
    },
  });
  assert.deepEqual(state.runtimeRecognition, {
    enabled: true,
    strategy: "primary",
    source: "agent",
  });
  assert.ok(
    optionLists[2].some((option) => option.includes("额外调用一次模型")),
  );
  assert.ok(optionLists[2].some((option) => option.includes("不产生模型调用")));
  assert.match(messages.at(-1), /agent 复用当前模型/);
});

test("interactive panels expose task actions, diagnostics and annotated command help", async () => {
  for (const [main, submenu, expected] of [
    [
      "任务与审批 — 查看账本、批准计划、开始新任务或取消计划",
      "查看任务账本 — 目标、要求、约束来源、计划及授权版本",
      /task/,
    ],
    [
      "诊断 — 查看注入原文、状态、配置、校验与历史",
      "运行状态 — 当前任务阶段、模型和最近识别来源",
      /recognition:/,
    ],
    [
      "命令说明 — 查看全部文本命令、作用和注意事项",
      null,
      /\/policy recognition agent/,
    ],
  ]) {
    const state = {
      runtimeMode: null,
      runtimeProfile: null,
      runtimeRecognition: null,
      onceMode: null,
      phase: "idle",
      outcome: "idle",
      task: null,
      history: [],
      currentModel: null,
      lastActivity: null,
    };
    const selections = submenu ? [main, submenu] : [main];
    const messages = [];
    const handler = createCommandHandler({
      packageRoot: process.cwd(),
      getState: () => state,
    });
    await handler("", {
      ui: {
        select: async () => selections.shift(),
        notify: (message) => messages.push(message),
      },
    });
    assert.match(messages.at(-1), expected);
  }
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
