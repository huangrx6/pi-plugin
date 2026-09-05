import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyPlanResponse,
  hasAutonomyGrant,
} from "../src/core/approval.js";
import { extractExecutionIntent } from "../src/core/intent.js";
import {
  createState,
  preview,
  buildEffectiveConfig,
  validateConfig,
} from "../extensions/policy-engine/state.js";
import { registerLifecycleHandlers } from "../extensions/policy-engine/lifecycle.js";
import { createCommandHandler } from "../extensions/policy-engine/commands.js";
import { buildSemanticRequestBody } from "../src/core/semantic.js";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const review =
  "你全局审查审查，看看我当前的项目还差什么东西，还需要优化什么东西，还是直接进入测试阶段\n你要着重考虑，后续每个流程阶段的控制，配置是否方便\nrabbitmq 队列绑定不同的模型实例，模型是否方便切换，是否支持不同平台的模型\n入向量库，什么时机，怎么入的，又是怎么被使用的\n你需要全面的进行考虑";
const planPrompt = "修改生产数据库 schema，先给方案，确认后再执行";
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "pi-policy-upgrade-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
  const cwd = join(temp, "project");
  mkdirSync(cwd);
  const configPath = join(
    temp,
    "agent",
    "extensions-data",
    "pi-policy-engine",
    "config.json",
  );
  const configure = (data) => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(data));
  };
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  });
  return { temp, cwd, configure, configPath };
}
function session(cwd, sessionId = "session-a", entries = []) {
  const state = createState();
  const handlers = new Map();
  const notices = [];
  const statuses = [];
  const ctx = {
    cwd,
    model: { provider: "deepseek", id: "chat" },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      getLeafId: () => entries.at(-1)?.id ?? null,
    },
    ui: {
      notify: (m) => notices.push(m),
      setStatus: (_key, value) => statuses.push(value),
    },
  };
  const pi = {
    on: (n, f) => handlers.set(n, f),
    appendEntry: (customType, data) =>
      entries.push({
        id: `entry-${entries.length}`,
        type: "custom",
        customType,
        data: structuredClone(data),
      }),
  };
  registerLifecycleHandlers(pi, { packageRoot, getState: () => state });
  const command = createCommandHandler({
    packageRoot,
    getState: () => state,
    pi,
  });
  return {
    state,
    entries,
    notices,
    statuses,
    ctx,
    command,
    async start() {
      await handlers.get("session_start")({}, ctx);
    },
    async turn(prompt) {
      const result = await handlers.get("before_agent_start")(
        { prompt, systemPrompt: "BASE" },
        ctx,
      );
      entries.push({
        id: `entry-${entries.length}`,
        type: "message",
        message: { role: "user", content: prompt },
      });
      return result;
    },
    async end(stopReason = "stop", text = null) {
      if (text === null)
        text =
          "```policy-plan\n" +
          JSON.stringify({
            taskId: state.task?.id,
            planVersion: state.task?.planVersion,
            goal: state.task?.goal ?? "test goal",
            steps: [
              {
                action: "Inspect and apply the bounded change",
                verification: "Run targeted checks and inspect the diff",
              },
            ],
          }) +
          "\n```";
      const message = {
        role: "assistant",
        stopReason,
        content: text ? [{ type: "text", text }] : [],
      };
      entries.push({ id: `entry-${entries.length}`, type: "message", message });
      await handlers.get("agent_end")({ messages: [message] }, ctx);
    },
    async tree(branch) {
      entries.splice(0, entries.length, ...branch);
      await handlers.get("session_tree")({}, ctx);
    },
  };
}

test("negative, quoted and interrogative autonomy never approves", () => {
  for (const p of [
    "不要自主执行，等我确认",
    "不准自己决定",
    "解释一下“自主执行”是什么意思",
    "解释一下自主执行是什么意思",
    "can you act autonomously?",
    "自主执行吗？",
    "把“自主执行”改成“等我确认”",
    "不用问我了，等我确认后再执行",
    "don't act autonomously",
  ]) {
    assert.notEqual(classifyPlanResponse(p), "approve", p);
    assert.equal(hasAutonomyGrant(p), false, p);
  }
  for (const p of [
    "不用问我了，但别动数据库",
    "act autonomously",
    "不用询问我，直接执行",
  ])
    assert.equal(hasAutonomyGrant(p), true, p);
});
test("negation and inspection objects retain read-only intent", () => {
  for (const p of [
    "审查当前项目，只分析，不修改",
    "请检查 RabbitMQ 模型路由和向量库写入使用链路",
    "review deletion logic",
    "分析数据库写入实现",
  ])
    assert.equal(extractExecutionIntent(p), "read-only", p);
  for (const p of [
    "检查后并修改代码",
    "分析接口然后修改代码",
    "请实现向量库写入逻辑",
  ])
    assert.equal(extractExecutionIntent(p), "mutate", p);
});
test("pending task → greeting → full review → next session", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  assert.equal(s.state.phase, "awaiting_approval");
  const id = s.state.task.id;
  const plan = s.state.task.planVersion;
  assert.equal(await s.turn("你好"), undefined);
  await s.end();
  assert.equal(s.state.phase, "awaiting_approval");
  assert.equal(s.state.task.id, id);
  assert.equal(s.state.task.planVersion, plan);
  const out = await s.turn(review);
  assert.equal(s.state.lastDecision.taskType, "review");
  assert.equal(s.state.lastDecision.executionIntent, "read-only");
  assert.equal(s.state.lastDecision.rigor, "standard");
  assert.notEqual(s.state.task.id, id);
  assert.match(out.systemPrompt, /Comprehensive Review/);
  assert.doesNotMatch(out.systemPrompt, /PLAN-ONLY|Plan revision requested/);
  const stranger = session(cwd, "session-b");
  await stranger.start();
  assert.equal(stranger.state.phase, "idle");
});
test("pending discussion has no execute policy and every transition is recorded", async (t) => {
  const { cwd, temp } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  const out = await s.turn("为什么第二步要这样做？");
  assert.equal(s.state.phase, "awaiting_approval");
  assert.match(out.systemPrompt, /PLAN-ONLY/);
  assert.doesNotMatch(
    out.systemPrompt,
    /The plan has been approved|Policy: rigor.strict-execute/,
  );
  await s.end();
  const rows = readFileSync(
    join(temp, "agent/extensions-data/pi-policy-engine/state/history.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  const discuss = rows.find((r) => r.relation === "discuss");
  assert.ok(discuss);
  assert.equal(discuss.sessionId, "session-a");
  assert.equal(discuss.phaseFrom, "awaiting_approval");
  assert.equal(discuss.intent, "mutate");
  assert.ok(discuss.configFingerprint);
  assert.ok(discuss.injectionFingerprint);
});
test("resume requires the same session and visible plan, fork/tree cannot steal approval", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  const beforePlan = structuredClone(s.entries);
  await s.end();
  const resumed = session(cwd, "session-a", structuredClone(s.entries));
  await resumed.start();
  assert.equal(resumed.state.phase, "awaiting_approval");
  const fork = session(cwd, "session-b", structuredClone(s.entries));
  await fork.start();
  assert.equal(fork.state.phase, "idle");
  await resumed.tree(beforePlan);
  assert.notEqual(resumed.state.phase, "awaiting_approval");
  const noPlan = structuredClone(s.entries).filter(
    (e) => e.id !== s.state.task.planEntryId,
  );
  const damaged = session(cwd, "session-a", noPlan);
  await damaged.start();
  assert.equal(damaged.state.phase, "idle");
});
test("off/cancel/reset are persisted immediately and do not restore", async (t) => {
  const { cwd } = fixture(t);
  for (const cmd of ["off", "cancel", "reset"]) {
    const s = session(cwd, `session-${cmd}`);
    await s.start();
    await s.turn(planPrompt);
    await s.end();
    await s.command(cmd, s.ctx);
    const resumed = session(cwd, `session-${cmd}`, structuredClone(s.entries));
    await resumed.start();
    assert.equal(resumed.state.phase, "idle", cmd);
    assert.equal(resumed.state.task, null, cmd);
  }
});
test("missing plan, failed execution and round end never imply completion", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end("error", "");
  assert.equal(s.state.outcome, "failed");
  assert.notEqual(s.state.phase, "awaiting_approval");
  await s.turn(planPrompt);
  await s.end("stop", "");
  assert.equal(s.state.outcome, "missing_plan");
  await s.turn(planPrompt);
  await s.end();
  await s.turn("批准");
  await s.end("aborted");
  assert.equal(s.state.outcome, "interrupted");
  await s.turn("继续");
  assert.equal(s.state.phase, "executing");
  await s.end();
  assert.equal(s.state.outcome, "unverified");
});
test("initial autonomy works for strict tasks, survives continuation, resets for new work", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn("修改生产数据库 schema，不用问我，自己决定");
  assert.equal(s.state.phase, "executing");
  await s.end();
  await s.turn("继续");
  assert.equal(s.state.phase, "executing");
  await s.end();
  await s.turn("实现生产数据库迁移，确认后再执行");
  assert.equal(s.state.phase, "planning");
  assert.equal(s.state.task.autonomy, false);
});
test("preview shares current runtime and pending state without changes or network", async (t) => {
  const { cwd, configure } = fixture(t);
  configure({
    semanticFallback: {
      enabled: true,
      endpoint: "https://example.invalid",
      model: "fake",
      apiKeyEnvVar: "PI_POLICY_UPGRADE_KEY",
    },
  });
  process.env.PI_POLICY_UPGRADE_KEY = "fake";
  t.after(() => delete process.env.PI_POLICY_UPGRADE_KEY);
  const state = createState();
  state.runtimeMode = "strict";
  const before = structuredClone(state);
  let calls = 0;
  const p = await preview({
    packageRoot,
    cwd,
    prompt: "修改一处注释",
    state,
    fetcher: async () => {
      calls++;
      throw Error("unexpected network");
    },
  });
  assert.equal(p.decision.rigor, "strict");
  assert.equal(calls, 0);
  assert.deepEqual(state, before);
  // Disabled network configuration for actual lifecycle calls in this fixture.
  configure({ semanticFallback: { enabled: false } });
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  const snap = structuredClone(s.state);
  const predicted = await preview({
    packageRoot,
    cwd,
    prompt: "为什么第二步要这样做？",
    state: s.state,
    model: s.ctx.model,
  });
  assert.deepEqual(s.state, snap);
  const actual = await s.turn("为什么第二步要这样做？");
  assert.equal(actual.systemPrompt, "BASE\n\n" + predicted.injected);
});
test("schema errors are diagnosable and invalid edits retain last valid configuration", async (t) => {
  const { cwd, configure, configPath } = fixture(t);
  const state = createState();
  configure({ mode: "strict", maxDomains: 1 });
  assert.equal(
    buildEffectiveConfig({ packageRoot, cwd, state }).mode,
    "strict",
  );
  for (const bad of [
    { domainHints: "backend" },
    { includePolicies: 123 },
    { showStatus: "false" },
    { semanticFallback: { enabled: "true" } },
    { projectPolicyMaxBytes: -1 },
    null,
  ]) {
    assert.doesNotThrow(() =>
      validateConfig({ config: bad, packageRoot, cwd }),
    );
    assert.equal(validateConfig({ config: bad, packageRoot, cwd }).ok, false);
  }
  writeFileSync(configPath, "{broken");
  const held = buildEffectiveConfig({ packageRoot, cwd, state });
  assert.equal(held.mode, "strict");
  assert.equal(held.maxDomains, 1);
  assert.ok(held._usingLastValid);
  assert.ok(held._diagnostics.length);
  configure({ mode: "quick" });
  const next = buildEffectiveConfig({ packageRoot, cwd, state });
  assert.equal(next.mode, "quick");
  assert.equal(next._sources.mode, configPath);
});
test("global provider aliases override packaged adaptation and optional API fields", async (t) => {
  const { cwd, configure } = fixture(t);
  configure({
    modelRules: [
      { provider: "proxy", model: "ds-*", policy: "model.deepseek" },
    ],
  });
  const p = await preview({
    packageRoot,
    cwd,
    prompt: "修复接口",
    model: { provider: "proxy", id: "ds-chat" },
  });
  assert.equal(p.decision.modelPolicy, "model.deepseek");
  assert.match(p.injected, /DeepSeek Adaptation/);
  const body = buildSemanticRequestBody("model", "{}", {
    jsonResponse: false,
    temperature: null,
  });
  assert.equal("temperature" in body, false);
  assert.equal("response_format" in body, false);
});
test("required boundaries precede large project policies; impossible budgets block execution", async (t) => {
  const { cwd, configure } = fixture(t);
  mkdirSync(join(cwd, ".pi/policies"), { recursive: true });
  writeFileSync(join(cwd, ".pi/policies/large.md"), "context ".repeat(1000));
  configure({ policyMaxBytes: 1500 });
  const p = await preview({ packageRoot, cwd, prompt: planPrompt });
  assert.ok(p.policies.some((x) => x.id === "intent.mutate"));
  assert.ok(p.policies.some((x) => x.id === "rigor.strict-plan"));
  configure({ policyMaxBytes: 1 });
  const blocked = await preview({ packageRoot, cwd, prompt: planPrompt });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.injected, /Do not execute changes/);
});
test("revisions keep reasons bounded and a changed model recomposes pending policy", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  for (let i = 0; i < 15; i++) {
    await s.turn("调整计划，第二步不要改数据库");
    await s.end();
  }
  assert.ok(s.state.lastDecision.reasons.length < 30);
  s.ctx.model = { provider: "minimax-cn", id: "MiniMax-M3" };
  const out = await s.turn("为什么第二步要这样做？");
  assert.match(out.systemPrompt, /MiniMax M3 Adaptation/);
  assert.doesNotMatch(out.systemPrompt, /DeepSeek Adaptation/);
});

test("explicit approval with a narrowing constraint executes and retains scope on continuation", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  const out = await s.turn("批准，但别动数据库");
  assert.equal(s.state.phase, "executing");
  assert.match(out.systemPrompt, /别动数据库/);
  await s.end();
  const continued = await s.turn("继续");
  assert.equal(s.state.phase, "executing");
  assert.match(continued.systemPrompt, /别动数据库/);
});

test("save selections persists only chosen mode/profile and preserves unrelated settings", async (t) => {
  const { cwd, configure, configPath } = fixture(t);
  configure({ mode: "auto", maxDomains: 1 });
  const s = session(cwd);
  await s.start();
  await s.command("strict", s.ctx);
  await s.command("profile review", s.ctx);
  await s.command("save global", s.ctx);
  const saved = JSON.parse(readFileSync(configPath));
  assert.equal(saved.mode, "strict");
  assert.equal(saved.profile, "review");
  assert.equal(saved.maxDomains, 1);
  assert.equal(saved.historyFile, undefined);
  writeFileSync(configPath, "{broken");
  await s.command("save global", s.ctx);
  assert.equal(readFileSync(configPath, "utf8"), "{broken");
  assert.match(s.notices.at(-1), /invalid configuration/);
  await s.command("save project", s.ctx);
  assert.deepEqual(
    JSON.parse(readFileSync(join(cwd, ".pi/policy-engine.json"))),
    { mode: "strict", profile: "review" },
  );
});

test("once mode survives greetings and discussions then applies to the next task", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  await s.command("once quick", s.ctx);
  await s.turn("你好");
  assert.equal(s.state.onceMode, "quick");
  await s.turn("为什么第二步要这样做？");
  assert.equal(s.state.onceMode, "quick");
  assert.equal(s.state.phase, "awaiting_approval");
  await s.end();
  await s.turn("修改一处注释");
  assert.equal(s.state.onceMode, null);
  assert.equal(s.state.lastDecision.rigor, "quick");
  assert.equal(s.state.phase, "executing");
});

test("pinned strict read-only review never claims an approved implementation plan", async (t) => {
  const { cwd } = fixture(t);
  const state = createState();
  state.runtimeMode = "strict";
  const p = await preview({
    packageRoot,
    cwd,
    prompt: "只分析项目架构，不修改",
    state,
  });
  assert.equal(p.decision.rigor, "strict");
  assert.match(p.injected, /Strict Read-only Review/);
  assert.doesNotMatch(
    p.injected,
    /The plan has been approved|Stop after the plan and ask for approval/,
  );
  assert.equal(p.blocked, false);
});

const interpretation = (overrides = {}) => ({
  relation: "new",
  taskType: "coding",
  executionIntent: "mutate",
  risk: "medium",
  domains: [],
  coverage: "focused",
  constraints: [],
  ...overrides,
});
function primary(t, configure, response) {
  configure({
    semanticFallback: {
      enabled: true,
      strategy: "primary",
      apiKeyEnvVar: null,
      endpoint: "http://localhost:9999/v1/chat/completions",
      model: "test",
    },
  });
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, opts) => {
    requests.push(JSON.parse(opts.body));
    const result =
      typeof response === "function" ? response(requests.at(-1)) : response;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
    };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

test("long continuation has one task boundary and preserves scope/risk/authorization", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  await s.turn("批准，但别动数据库");
  const id = s.state.task.id;
  await s.end();
  const out = await s.turn("继续处理当前任务，先补测试，其他都按原计划");
  assert.equal(s.state.task.id, id);
  assert.equal(s.state.phase, "executing");
  assert.equal(s.state.lastDecision.rigor, "strict");
  assert.ok(s.state.lastDecision.domains.includes("database"));
  assert.match(out.systemPrompt, /别动数据库/);
});

test("initial and revised requirements retain full source text", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  const prompt = planPrompt + "，必须保持接口兼容";
  await s.turn(prompt);
  assert.equal(s.state.task.goal, prompt);
  assert.equal(s.state.task.constraintLedger[0].source, "user");
  await s.end();
  await s.turn("调整计划，第二步不要改数据库");
  assert.equal(s.state.task.planVersion, 2);
  assert.ok(
    s.state.task.requirements.some(
      (r) => r.text === "调整计划，第二步不要改数据库",
    ),
  );
  assert.ok(
    s.state.task.constraintLedger.some((c) => c.text.includes("不要改数据库")),
  );
  assert.match(
    (await s.turn("继续处理当前任务")).systemPrompt,
    /必须保持接口兼容/,
  );
});

test("ordinary assistant text is not a plan, and explicit approval requires a plan", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end("stop", "尚未找到数据库定义，请提供文件路径。");
  assert.equal(s.state.phase, "planning");
  assert.equal(s.state.outcome, "missing_plan");
  await s.command("approve", s.ctx);
  assert.equal(s.state.phase, "planning");
  await s.turn("好");
  assert.equal(s.state.phase, "planning");
  await s.end();
  await s.command("approve", s.ctx);
  assert.equal(s.state.task.authorizationSource, "user_command");
  await s.turn("继续");
  assert.equal(s.state.phase, "executing");
});

test("task reset is explicit and persisted, inspection does not mutate it", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  const before = structuredClone(s.state.task);
  await s.command("task", s.ctx);
  assert.deepEqual(s.state.task, before);
  await s.command("new", s.ctx);
  const resumed = session(cwd, "session-a", structuredClone(s.entries));
  await resumed.start();
  assert.equal(resumed.state.task, null);
});

test("primary model overrides a confident rule classification using full task context", async (t) => {
  const { cwd, configure } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt + "，不要改公开接口");
  await s.end();
  const oldId = s.state.task.id;
  const requests = primary(
    t,
    configure,
    interpretation({
      relation: "new",
      taskType: "review",
      executionIntent: "read-only",
      risk: "low",
      coverage: "comprehensive",
    }),
  );
  await s.turn("我想全面审查当前项目，只分析，不修改");
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.equal(payload.currentTask.id, oldId);
  assert.match(payload.currentTask.goal, /不要改公开接口/);
  assert.ok(payload.currentTask.plan.steps.length);
  assert.notEqual(s.state.task.id, oldId);
  assert.equal(s.state.lastDecision.executionIntent, "read-only");
  assert.equal(s.state.lastDecision.taskType, "review");
  assert.equal(s.state.phase, "executing");
  assert.equal(s.state.lastDecision.recognition.source, "model");
  assert.equal(s.state.lastDecision.confidence, null);
  assert.equal(requests.length, 1);
});

test("semantic continuation and revision retain identity but revision invalidates approval", async (t) => {
  const { cwd, configure } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  await s.turn("批准");
  await s.end();
  const id = s.state.task.id;
  let response = interpretation({
    relation: "continue",
    risk: "low",
    domains: ["database"],
  });
  primary(t, configure, () => response);
  await s.turn("按咱们刚才商量的往下推进，把剩余部分都收尾");
  assert.equal(s.state.task.id, id);
  assert.equal(s.state.phase, "executing");
  assert.equal(s.state.lastDecision.risk, "high");
  await s.end();
  response = interpretation({
    relation: "revise",
    risk: "high",
    constraints: ["必须保持旧接口"],
  });
  await s.turn("我想给当前任务加个要求，必须保持旧接口");
  assert.equal(s.state.task.id, id);
  assert.equal(s.state.phase, "planning");
  assert.equal(s.state.task.approvedVersion, undefined);
  assert.ok(s.state.task.constraints.includes("必须保持旧接口"));
});

test("semantic model cannot invent grants or bypass pending approval", async (t) => {
  const { cwd, configure } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  primary(t, configure, interpretation({ relation: "continue" }));
  await s.turn("这个方案看起来怎么样？");
  assert.equal(s.state.phase, "awaiting_approval");
  assert.equal(s.state.task.approvedVersion, undefined);
});

test("semantic uncertainty cannot authorize modifications", async (t) => {
  const { cwd, configure } = fixture(t);
  primary(t, configure, interpretation({ relation: "uncertain" }));
  const s = session(cwd);
  await s.start();
  const result = await s.turn("照之前说的弄一下");
  assert.equal(s.state.lastDecision.executionIntent, "unclear");
  assert.match(result.systemPrompt, /Before making any change/);
});

test("recognition selection saves globally without replacing endpoint and resets cleanly", async (t) => {
  const { cwd, configure, configPath } = fixture(t);
  configure({
    semanticFallback: {
      enabled: false,
      model: "private-model",
      endpoint: "http://localhost:8080/v1/chat/completions",
      apiKeyEnvVar: "PRIVATE_KEY_NAME",
    },
  });
  const s = session(cwd);
  await s.start();
  await s.command("recognition primary", s.ctx);
  await s.command("save global", s.ctx);
  const fb = JSON.parse(readFileSync(configPath)).semanticFallback;
  assert.equal(fb.model, "private-model");
  assert.equal(fb.apiKeyEnvVar, "PRIVATE_KEY_NAME");
  assert.equal(fb.enabled, true);
  assert.equal(fb.strategy, "primary");
  await s.command("recognition off", s.ctx);
  assert.equal(
    buildEffectiveConfig({ packageRoot, cwd, state: s.state }).semanticFallback
      .enabled,
    false,
  );
  await s.command("reset", s.ctx);
  assert.equal(s.state.runtimeRecognition, null);
  assert.equal(
    buildEffectiveConfig({ packageRoot, cwd, state: s.state }).semanticFallback
      .enabled,
    true,
  );
});

test("next-task depth override is not consumed by an approved continuation", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  await s.command("once quick", s.ctx);
  await s.command("approve", s.ctx);
  await s.turn("继续处理当前任务，先补测试，其他都按原计划");
  assert.equal(s.state.onceMode, "quick");
  assert.equal(s.state.lastDecision.rigor, "strict");
  await s.end();
  await s.turn("修改一处注释");
  assert.equal(s.state.onceMode, null);
  assert.equal(s.state.lastDecision.rigor, "quick");
});

test("restoring a plan checks its content, not merely an existing entry id", async (t) => {
  const { cwd } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn(planPrompt);
  await s.end();
  const entries = structuredClone(s.entries);
  const planEntry = entries.find((e) => e.id === s.state.task.planEntryId);
  planEntry.message.content = [
    { type: "text", text: "Please provide a path." },
  ];
  const resumed = session(cwd, "session-a", entries);
  await resumed.start();
  assert.notEqual(resumed.state.phase, "awaiting_approval");
});

test("offline new-review variants cannot inherit an old pending mutation", async (t) => {
  const { cwd } = fixture(t);
  for (const message of [
    "我想全面审查当前项目，只分析，不修改",
    "另外帮我检查 RabbitMQ 队列与模型切换配置",
  ]) {
    const s = session(cwd);
    await s.start();
    await s.turn(planPrompt);
    await s.end();
    const id = s.state.task.id;
    await s.turn(message);
    assert.notEqual(s.state.task.id, id);
    assert.equal(s.state.lastDecision.executionIntent, "read-only");
    assert.equal(s.state.phase, "executing");
  }
});

test("same-task constraints do not revoke explicit autonomy", async (t) => {
  const { cwd, configure } = fixture(t);
  const s = session(cwd);
  await s.start();
  await s.turn("修改生产数据库 schema，不用问我，自己决定");
  await s.end();
  primary(
    t,
    configure,
    interpretation({
      relation: "revise",
      risk: "high",
      constraints: ["必须保持旧接口"],
    }),
  );
  await s.turn("当前任务必须保持旧接口");
  assert.equal(s.state.task.autonomy, true);
  assert.equal(s.state.phase, "executing");
  assert.ok(s.state.task.constraints.includes("必须保持旧接口"));
});

test("agent recognition preflight selects the strategy and reports loading status", async (t) => {
  const { cwd, configure } = fixture(t);
  configure({
    semanticFallback: {
      source: "agent",
      enabled: true,
      strategy: "primary",
      endpoint: "https://must-not-call.invalid",
      apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    },
  });
  const s = session(cwd);
  const first = {
    provider: "session-provider",
    id: "first",
    api: "custom-api",
    baseUrl: "https://provider.invalid",
  };
  s.ctx.model = first;
  let calls = 0;
  s.ctx.modelRegistry = {
    complete: async () => {
      calls++;
      return {
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              relation: "new",
              taskType: calls === 1 ? "debugging" : "review",
              executionIntent: calls === 1 ? "mutate" : "read-only",
              risk: calls === 1 ? "medium" : "low",
              domains: [],
              coverage: "focused",
              constraints: [],
            }),
          },
        ],
      };
    },
  };
  await s.start();
  const out = await s.turn("修复 parser");
  assert.equal(calls, 1);
  assert.match(out.systemPrompt, /Policy: intent\.mutate/);
  assert.match(out.systemPrompt, /Policy: flow\.debug-first/);
  assert.equal(s.state.lastDecision.recognition.source, "agent");
  assert.equal(s.state.lastDecision.recognition.reason, "contextual");
  assert.equal(s.state.lastDecision.recognition.transport, "host");
  assert.equal(
    s.state.lastDecision.recognition.model,
    "session-provider/first",
  );
  assert.ok(s.statuses.includes("policy:意图识别中…"));
  assert.ok(s.statuses.some((value) => value.startsWith("policy:已识别")));
  await s.end();
  s.ctx.model = {
    provider: "another-provider",
    id: "second",
    api: "another-api",
  };
  await s.turn("审查当前代码");
  assert.equal(calls, 2);
  assert.equal(s.state.lastDecision.taskType, "review");
  assert.equal(s.state.lastDecision.executionIntent, "read-only");
  assert.equal(
    s.state.lastDecision.recognition.model,
    "another-provider/second",
  );
});

test("agent semantic preview reports that a host model is required", async (t) => {
  const { cwd, configure } = fixture(t);
  configure({
    semanticFallback: {
      source: "agent",
      enabled: true,
      strategy: "primary",
      endpoint: "https://must-not-call.invalid",
      apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    },
  });
  const p = await preview({
    packageRoot,
    cwd,
    prompt: "检查当前代码",
    semantic: true,
    fetcher: () => assert.fail("must not switch providers"),
  });
  assert.equal(p.decision.recognition.reason, "agent_unavailable");
  assert.doesNotMatch(p.injected, /Current Agent Context Interpretation/);
});

test("failed agent preflight blocks policy execution instead of silently routing", async (t) => {
  const { cwd, configure } = fixture(t);
  configure({
    semanticFallback: { source: "agent", enabled: true, strategy: "primary" },
  });
  const s = session(cwd);
  s.ctx.modelRegistry = {
    complete: async () => {
      throw new Error("temporary model failure");
    },
  };
  await s.start();
  const out = await s.turn("修改 parser");
  assert.equal(s.state.lastDecision.preflightBlocked, true);
  assert.match(out.systemPrompt, /Intent preflight blocked/);
  assert.equal(s.state.lastDecision.rigor, "off");
  assert.ok(s.statuses.includes("policy:意图识别中…"));
  assert.ok(s.statuses.includes("policy:意图识别失败，已回退"));
});
