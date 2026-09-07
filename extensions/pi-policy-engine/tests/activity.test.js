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

test("failed recognition explains the real boundary and parser diagnostics", () => {
  const activity = activitySnapshot(
    {
      preflightBlocked: true,
      rigor: "off",
      recognition: {
        source: "agent",
        reason: "invalid_json",
        attempts: 2,
        initialFailure: "invalid_json",
        initialParseIssue: "malformed_json_object",
        parseIssue: "no_json_object",
        responseChars: 17,
        responsePreview: "plain explanation",
        durationMs: 2400,
      },
      loadedPolicies: ["intent.unclear"],
      reasons: ["recognition-preflight:invalid_json"],
    },
    "idle",
    "instructions",
  );
  const text = activityText(activity);
  assert.match(activity.summary, /本轮未加载任务策略/);
  assert.doesNotMatch(activity.summary, /已阻止策略执行/);
  assert.match(text, /attempts=2/);
  assert.match(text, /first=invalid_json\/malformed_json_object/);
  assert.match(text, /final=no_json_object/);
  assert.match(text, /响应预览：plain explanation/);
  assert.match(text, /运行版本：0\.33\.3；当前已加载：0\.33\.3/);
  assert.match(text, /追加停止执行/);
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
  assert.equal(optionLists[0].length, 7);
  assert.ok(optionLists[0].some((option) => option.startsWith("识别模型")));
  assert.ok(optionLists[0].some((option) => option.startsWith("自动处理")));
  assert.ok(optionLists[0].some((option) => option.startsWith("谨慎处理")));
  assert.ok(optionLists[0].some((option) => option.startsWith("识别负载")));
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

// 0.36.1: recognition-context profile is switchable from the panel.

test("panel 识别负载 picker saves the profile and preserves key overrides", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const temp = mkdtempSync(join(tmpdir(), "pi-policy-ctx-panel-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const configPath = join(
    temp,
    "agent",
    "extensions-data",
    "pi-policy-engine",
    "config.json",
  );
  mkdirSync(dirname(configPath), { recursive: true });
  // 手写的键覆盖必须在高频切档中幸存（config-writer 深合并）。
  writeFileSync(
    configPath,
    JSON.stringify({
      recognition: {
        enabled: true,
        source: "agent",
        context: { profile: "minimal", conversationTurns: 6 },
      },
    }),
  );

  const state = {
    runtimeMode: null,
    runtimeRecognition: null,
    phase: "idle",
    task: null,
    lastActivity: null,
  };
  const selects = [];
  const notices = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  const ctx = {
    ui: {
      select: async (_title, options) => {
        selects.push(options);
        if (selects.length === 1)
          return options.find((o) => o.startsWith("识别负载"));
        return options.find((o) => o.startsWith("标准"));
      },
      notify: (m, level) => notices.push({ m, level }),
    },
  };
  await handler("", ctx);

  assert.equal(selects.length, 2, "two-level picker");
  // 二级面板：三档 + 返回，当前档标注
  assert.equal(selects[1].length, 4);
  assert.ok(
    selects[1].some(
      (o) => o.startsWith("极简（推荐）") && o.endsWith("（当前）"),
    ),
  );
  assert.ok(notices.some((n) => n.level === "success" && /标准/.test(n.m)));
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.recognition.context.profile, "standard");
  assert.equal(
    saved.recognition.context.conversationTurns,
    6,
    "override preserved",
  );
});

test("panel 识别负载 cancel and 返回 stay silent", async () => {
  const state = {
    runtimeMode: null,
    runtimeRecognition: null,
    phase: "idle",
    task: null,
    lastActivity: null,
  };
  const notices = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  for (const secondChoice of [undefined, "返回"]) {
    let call = 0;
    notices.length = 0;
    await handler("", {
      ui: {
        select: async (_t, options) => {
          call += 1;
          return call === 1
            ? options.find((o) => o.startsWith("识别负载"))
            : secondChoice;
        },
        notify: (m, level) => notices.push({ m, level }),
      },
    });
    assert.equal(notices.length, 0, `silent for ${String(secondChoice)}`);
  }
});

test("/policy context sets directly and reports usage without arguments", async (t) => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temp = mkdtempSync(join(tmpdir(), "pi-policy-ctx-cmd-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const state = {
    runtimeMode: null,
    runtimeRecognition: null,
    phase: "idle",
    task: null,
    lastActivity: null,
  };
  const notices = [];
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  const ctx = { ui: { notify: (m, level) => notices.push({ m, level }) } };

  await handler("context", ctx);
  assert.ok(notices[0].m.includes("用法"));

  await handler("context rich", ctx);
  assert.ok(notices[1].level === "success" && /完整/.test(notices[1].m));
  const configPath = join(
    temp,
    "agent",
    "extensions-data",
    "pi-policy-engine",
    "config.json",
  );
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.recognition.context.profile, "rich");
});

// 0.37.0: recognition model selection from the panel + token usage.

test("panel 识别模型 lists configured models and saves agentModel", async (t) => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temp = mkdtempSync(join(tmpdir(), "pi-policy-rm-panel-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const state = {
    runtimeMode: null, runtimeRecognition: null,
    phase: "idle", task: null, lastActivity: null,
  };
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  const selects = [];
  const notices = [];
  const ctx = {
    modelRegistry: {
      getAvailable: () => [
        { provider: "zai-coding-cn", id: "glm-5.3", name: "GLM 5.3" },
        { provider: "zai-coding-cn", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
      ],
    },
    ui: {
      select: async (_t, options) => {
        selects.push(options);
        if (selects.length === 1) return options.find((o) => o.startsWith("识别模型"));
        return options.find((o) => o.startsWith("zai-coding-cn/glm-5.3-flash"));
      },
      notify: (m, level) => notices.push({ m, level }),
    },
  };
  await handler("", ctx);
  assert.equal(selects.length, 2);
  // 二级列表：跟随主模型 + 2 个模型 + 返回
  assert.equal(selects[1].length, 4);
  assert.ok(selects[1][0].startsWith("跟随主模型"));
  assert.ok(notices.some((n) => n.level === "success" && /glm-5\.3-flash/.test(n.m)));
  const configPath = join(
    temp, "agent", "extensions-data", "pi-policy-engine", "config.json",
  );
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.recognition.agentModel, "zai-coding-cn/glm-5.3-flash");
});

test("/policy model sets and clears the recognition model directly", async (t) => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const temp = mkdtempSync(join(tmpdir(), "pi-policy-rm-cmd-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const state = {
    runtimeMode: null, runtimeRecognition: null,
    phase: "idle", task: null, lastActivity: null,
  };
  const handler = createCommandHandler({
    packageRoot: process.cwd(),
    getState: () => state,
  });
  const notices = [];
  const ctx = { ui: { notify: (m, level) => notices.push({ m, level }) } };

  await handler("model", ctx);
  assert.match(notices[0].m, /跟随主模型/);
  await handler("model bad-name", ctx);
  assert.equal(notices[1].level, "warning");
  await handler("model zai-coding-cn/glm-5.3-flash", ctx);
  assert.equal(notices[2].level, "success");
  await handler("model auto", ctx);
  assert.match(notices[3].m, /跟随主模型/);
  const configPath = join(
    temp, "agent", "extensions-data", "pi-policy-engine", "config.json",
  );
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.recognition.agentModel, null);
});
