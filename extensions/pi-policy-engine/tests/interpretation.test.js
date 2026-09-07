import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretTask,
  interpretationContext,
  parseRecognitionResponse,
  validateInterpretation,
} from "../src/core/interpretation.js";
import { readPlanReport } from "../src/core/task-contract.js";
import { validateShape } from "../src/core/schema.js";

const valid = {
  relation: "continue",
  taskType: "coding",
  executionIntent: "mutate",
  risk: "low",
  domains: [],
  coverage: "focused",
  constraints: [],
};
const state = { task: null };
const config = (extra = {}) => ({
  recognition: {
    enabled: true,
    model: "fixture-model",
    endpoint: "http://localhost:8080/v1/chat/completions",
    apiKeyEnvVar: null,
    timeoutMs: 100,
    ...extra,
  },
});
const response = (value = valid) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(value) } }],
  }),
});

test("OpenAI compatible local service supports no auth and omitted optional fields", async () => {
  const result = await interpretTask({
    prompt: "继续",
    state,
    config: config({ jsonResponse: false, temperature: null }),
    fetcher: async (_url, request) => {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.redirect, "error");
      const body = JSON.parse(request.body);
      assert.equal(body.temperature, undefined);
      assert.equal(body.response_format, undefined);
      assert.equal(body.messages[0].role, "system");
      assert.equal(JSON.parse(body.messages[1].content).message, "继续");
      return response();
    },
  });
  assert.equal(result.source, "model");
});

test("Anthropic Messages adapter uses system and content blocks", async () => {
  const result = await interpretTask({
    prompt: "继续",
    state,
    config: config({ protocol: "anthropic" }),
    fetcher: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.ok(body.system);
      assert.ok(body.max_tokens);
      assert.equal(body.messages.length, 1);
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: JSON.stringify(valid) }],
        }),
      };
    },
  });
  assert.equal(result.source, "model");
  assert.equal(result.protocol, "anthropic");
});

test("malformed response and network failures report bounded diagnostic codes", async () => {
  const cases = [
    ["http_error", async () => ({ ok: false, status: 429 })],
    [
      "invalid_json",
      async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "not json" } }] }),
      }),
    ],
    ["invalid_schema", async () => response({ ...valid, autonomy: true })],
    ["invalid_response", async () => ({ ok: true, json: async () => ({}) })],
    [
      "request_failed",
      async () => {
        throw Error("private server secret");
      },
    ],
  ];
  for (const [reason, fetcher] of cases) {
    const r = await interpretTask({
      prompt: "继续",
      state,
      config: config(),
      fetcher,
    });
    assert.equal(r.source, "endpoint");
    assert.equal(r.reason, reason);
    assert.doesNotMatch(JSON.stringify(r), /private server secret/);
  }
});

test("recognition accepts one validated object with common model wrappers", async () => {
  const json = JSON.stringify(valid);
  for (const [content, format] of [
    [json, "json"],
    [`\uFEFF${json}`, "json"],
    [`\`\`\`json\n${json}\n\`\`\``, "markdown_fence"],
    [`识别结果如下：\n${json}`, "embedded_json"],
    [`示例格式 {not-json}\n最终结果：${json}`, "embedded_json"],
  ]) {
    const result = await interpretTask({
      prompt: "继续",
      state,
      config: config(),
      fetcher: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      }),
    });
    assert.equal(result.reason, "contextual");
    assert.equal(result.responseFormat, format);
  }
});

test("wrapper recovery rejects ambiguous or malformed model output", () => {
  const json = JSON.stringify(valid);
  assert.equal(parseRecognitionResponse(`${json}\n${json}`), null);
  assert.equal(
    parseRecognitionResponse(`\`\`\`json\n${json}\n\`\`\`\n${json}`),
    null,
  );
  assert.equal(parseRecognitionResponse(`before {not-json} after`), null);
  assert.equal(parseRecognitionResponse("plain explanation"), null);
});

test("invalid model output gets one bounded format repair attempt", async () => {
  const calls = [];
  const result = await interpretTask({
    prompt: "进行关闭",
    state,
    config: config({ source: "agent", timeoutMs: 100 }),
    agentClassifier: {
      model: "host/model",
      complete: async ({ systemPrompt, payload }) => {
        calls.push({ systemPrompt, payload: JSON.parse(payload) });
        return calls.length === 1
          ? "I cannot format this {yet}"
          : JSON.stringify(valid);
      },
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].payload.originalInput);
  assert.equal(calls[1].payload.invalidResponse, "I cannot format this {yet}");
  assert.equal(result.reason, "contextual");
  assert.equal(result.attempts, 2);
  assert.equal(result.initialFailure, "invalid_json");
  assert.equal(result.initialParseIssue, "malformed_json_object");
  assert.equal(result.responseFormat, "repaired_json");
});

test("failed repair records actionable parse diagnostics without throwing", async () => {
  const result = await interpretTask({
    prompt: "进行关闭",
    state,
    config: config({ source: "agent", timeoutMs: 100 }),
    agentClassifier: {
      model: "host/model",
      complete: async () => "plain explanation",
    },
  });
  assert.equal(result.reason, "invalid_json");
  assert.equal(result.attempts, 2);
  assert.equal(result.initialFailure, "invalid_json");
  assert.equal(result.initialParseIssue, "no_json_object");
  assert.equal(result.parseIssue, "no_json_object");
  assert.equal(result.responseChars, "plain explanation".length);
  assert.equal(result.responsePreview, "plain explanation");
});

test("deadline works when a transport ignores AbortSignal", async () => {
  const r = await interpretTask({
    prompt: "继续",
    state,
    config: config({ timeoutMs: 15 }),
    fetcher: () => new Promise(() => {}),
  });
  assert.equal(r.reason, "timeout");
});

test("deadline during repair preserves the first failure diagnostics", async () => {
  let calls = 0;
  const r = await interpretTask({
    prompt: "进行关闭",
    state,
    config: config({ source: "agent", timeoutMs: 15 }),
    agentClassifier: {
      model: "host/model",
      complete: async () => {
        calls++;
        return calls === 1 ? "not json" : new Promise(() => {});
      },
    },
  });
  assert.equal(r.reason, "timeout");
  assert.equal(r.attempts, 2);
  assert.equal(r.initialFailure, "invalid_json");
  assert.equal(r.initialParseIssue, "no_json_object");
});

test("disabled, missing key and oversized context make no network request", async () => {
  for (const [cfg, context, reason] of [
    [config({ enabled: false }), state, "disabled"],
    [
      config({ apiKeyEnvVar: "PI_POLICY_NONEXISTENT_TEST_KEY_027" }),
      state,
      "missing_key",
    ],
    [
      config({ maxContextChars: 1000 }),
      { task: null, prompt: "a".repeat(1100) },
      "context_too_large",
    ],
  ]) {
    const oversizedPrompt =
      reason === "context_too_large" ? "a".repeat(1100) : "继续";
    const r = await interpretTask({
      prompt: oversizedPrompt,
      state: context,
      config: cfg,
      fetcher: () => {
        assert.fail("must not call");
      },
    });
    assert.equal(r.reason, reason);
  }
});

test("response schema rejects fabricated constraints, quoted examples, grants and invalid enums", () => {
  for (const value of [
    { ...valid, relation: "approve" },
    { ...valid, taskType: "shell" },
    { ...valid, domains: ["imaginary"] },
    { ...valid, constraints: ["删除所有文件"] },
    { ...valid, constraints: ["自主执行"] },
    { ...valid, approved: true },
    { ...valid, relation: "conversation" },
  ])
    assert.equal(validateInterpretation(value, "解释“自主执行”的含义"), null);
  assert.ok(
    validateInterpretation(
      { ...valid, constraints: ["保持兼容"] },
      "继续，保持兼容",
    ),
  );
  assert.ok(
    validateInterpretation(
      {
        ...valid,
        relation: "uncertain",
        taskType: "conversation",
        executionIntent: "unclear",
        constraints: ["进行关闭"],
      },
      "进行关闭",
    ),
  );
  assert.equal(
    validateInterpretation(
      {
        ...valid,
        relation: "uncertain",
        taskType: "conversation",
        executionIntent: "read-only",
      },
      "进行关闭",
    ),
    null,
  );
});

test("plan reports require the current task, version and concrete verification", () => {
  const task = { id: "task-a", planVersion: 2 };
  const plan = {
    taskId: "task-a",
    planVersion: 2,
    goal: "Update code",
    steps: [
      {
        action: "Update handler",
        verification: "Run request regression checks",
      },
    ],
  };
  const text = (v) => "```policy-plan\n" + JSON.stringify(v) + "\n```";
  assert.equal(readPlanReport(text(plan), task).evidence, "assistant_reported");
  for (const p of [
    { ...plan, taskId: "task-b" },
    { ...plan, planVersion: 1 },
    { ...plan, steps: [] },
    { ...plan, steps: [{ action: "do it" }] },
  ])
    assert.equal(readPlanReport(text(p), task), null);
  assert.equal(readPlanReport(text(plan) + "\n" + text(plan), task), null);
  assert.equal(readPlanReport("Please provide a file path.", task), null);
});

test("recognition configuration rejects invalid protocol and context budget", () => {
  for (const extra of [
    { protocol: "anything" },
    { maxContextChars: 1 },
    { apiKeyEnvVar: 42 },
  ])
    assert.ok(validateShape(config(extra)).length);
  assert.equal(
    validateShape(config({ protocol: "anthropic", apiKeyEnvVar: null })).length,
    0,
  );
});

test("unknown settings point at version skew instead of a bare rejection", () => {
  // A key a future README may document but this runtime does not know yet.
  const skewed = validateShape(config({ someFutureKnob: 1 }));
  assert.ok(skewed.length);
  assert.match(
    skewed[0].message,
    /newer than the installed pi-plugin/,
    `expected the version-skew hint, got: ${skewed[0].message}`,
  );

  const top = validateShape({ mode: "auto", noSuchKey: 1 });
  assert.ok(top.length);
  assert.match(top[0].message, /newer than the installed pi-plugin/);

  assert.deepEqual(validateShape({ mode: "auto" }), []);
});

test("agent source uses the host model for a validated preflight interpretation", async () => {
  const cfg = config({
    source: "agent",
    apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    timeoutMs: 15,
  });
  const result = await interpretTask({
    prompt: "继续",
    state,
    config: cfg,
    currentModel: { provider: "host", id: "model" },
    agentClassifier: {
      model: "host/model",
      complete: async ({ systemPrompt, payload, signal }) => {
        assert.match(systemPrompt, /Return JSON only/);
        assert.equal(JSON.parse(payload).message, "继续");
        assert.ok(signal);
        return JSON.stringify(valid);
      },
    },
    fetcher: () => assert.fail("must not call endpoint"),
  });
  assert.equal(result.source, "agent");
  assert.equal(result.reason, "contextual");
  assert.equal(result.transport, "host");
  assert.equal(result.model, "host/model");
  assert.equal(result.interpretation.relation, "continue");
});

// 0.34.0: recognition.requestBody reaches the provider transport so slow
// reasoning models (e.g. ark-code-latest with server-side thinking) can
// have thinking disabled for the recognition preflight.

test("requestBody overrides reach the endpoint transport body", async () => {
  const seen = [];
  const cfg = config({
    source: "endpoint",
    endpoint: "http://127.0.0.1:9/v1",
    model: "test",
    timeoutMs: 15,
    apiKeyEnvVar: null,
    requestBody: { thinking: { type: "disabled" }, max_tokens: 99 },
  });
  const result = await interpretTask({
    prompt: "继续",
    state,
    config: cfg,
    fetcher: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(valid) } }],
        }),
      };
    },
  });
  assert.equal(result.reason, "contextual");
  const body = seen[0];
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 99, "overrides win over named fields");
  assert.ok(body.messages, "named fields survive the merge");
});

test("requestBody overrides reach the agent transport via samplingParams", async () => {
  const seen = [];
  const cfg = config({
    source: "agent",
    apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    timeoutMs: 15,
    requestBody: { thinking: { type: "disabled" } },
  });
  const result = await interpretTask({
    prompt: "继续",
    state,
    config: cfg,
    agentClassifier: {
      model: "host/model",
      complete: async ({ samplingParams }) => {
        seen.push(samplingParams);
        return JSON.stringify(valid);
      },
    },
    fetcher: () => assert.fail("must not call endpoint"),
  });
  assert.equal(result.reason, "contextual");
  assert.deepEqual(seen[0], { thinking: { type: "disabled" } });
});

// 0.36.0: recognition context profiles. The default (minimal) sends
// CONTEXT ONLY — message + newest conversation + goal — because
// requirements/constraints/plan govern execution, not classification,
// and the append-only ledger was both a per-turn token drain and (at
// ~34k chars) a permanent context_too_large failure on long tasks.

import { resolveContextOptions } from "../src/core/interpretation.js";

function hugeLedger() {
  return {
    task: {
      id: "t1",
      goal: "解析导入的文档并修正字段校验",
      requirements: Array.from({ length: 40 }, (_, i) => ({
        text: `第${i}轮用户要求原文`.padEnd(1200, `详${i}`),
        source: "user",
        relation: "response",
        planVersion: 3,
      })),
      constraints: Array.from(
        { length: 30 },
        (_, i) => `不要修改第${i}个模块的公开接口`,
      ),
      plan: {
        goal: "分步修正",
        steps: Array.from({ length: 8 }, (_, i) => ({
          action: `步骤${i}：检查并修正校验逻辑`.padEnd(600, "细"),
          verification: "跑回归",
        })),
      },
      planVersion: 3,
    },
    phase: "executing",
  };
}

test("default minimal profile sends context only — a huge ledger costs nothing", async () => {
  const ledger = hugeLedger();
  const ctx = interpretationContext(ledger, "继续", []);
  assert.ok(ctx.currentTask.goal.length <= 161);
  assert.deepEqual(ctx.currentTask.requirements, []);
  assert.deepEqual(ctx.currentTask.constraints, []);
  assert.equal(ctx.currentTask.plan, null);
  const payload = JSON.stringify(ctx);
  assert.ok(payload.length < 400, `minimal payload should be tiny, got ${payload.length}`);

  const cfg = config({
    source: "agent",
    apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    timeoutMs: 15,
  });
  const result = await interpretTask({
    prompt: "继续",
    state: ledger,
    config: cfg,
    agentClassifier: {
      model: "host/model",
      complete: async ({ payload: sent }) => {
        assert.ok(sent.length < 2000, `sent payload ${sent.length}`);
        return JSON.stringify(valid);
      },
    },
    fetcher: () => assert.fail("must not call endpoint"),
  });
  assert.equal(result.reason, "contextual");
  assert.equal(result.contextProfile, "minimal");
});

test("rich profile carries ledger entries and a plan summary", async () => {
  const ledger = hugeLedger();
  const cfg = config({
    source: "agent",
    apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    timeoutMs: 15,
    context: { profile: "rich" },
  });
  const result = await interpretTask({
    prompt: "继续",
    state: ledger,
    config: cfg,
    agentClassifier: {
      model: "host/model",
      complete: async ({ payload: sent }) => {
        const parsed = JSON.parse(sent);
        assert.equal(parsed.currentTask.requirements.length, 8);
        assert.ok(parsed.currentTask.requirements[0].text.length <= 251);
        assert.equal(parsed.currentTask.constraints.length, 6);
        assert.ok(parsed.currentTask.plan.steps.length);
        assert.equal(parsed.currentTask.plan.stepCount, 8);
        assert.ok(sent.length <= 24000);
        return JSON.stringify(valid);
      },
    },
    fetcher: () => assert.fail("must not call endpoint"),
  });
  assert.equal(result.reason, "contextual");
  assert.equal(result.contextProfile, "rich");
});

test("per-key overrides beat the profile preset", () => {
  const options = resolveContextOptions({
    profile: "standard",
    conversationTurns: 2,
    requirements: 5,
  });
  assert.equal(options.conversationTurns, 2);
  assert.equal(options.requirements, 5);
  assert.equal(options.conversationChars, 600, "preset value kept");
  assert.equal(options.constraints, 0);
});

test("unknown profile falls back to minimal", () => {
  const options = resolveContextOptions({ profile: "yolo" });
  assert.equal(options.conversationTurns, 4);
  assert.equal(options.plan, false);
});

test("budget shrink drops conversation turns before requirements", async () => {
  const ledger = hugeLedger();
  const cfg = config({
    source: "agent",
    apiKeyEnvVar: "MISSING_AGENT_TEST_KEY",
    timeoutMs: 15,
    context: { profile: "rich", maxContextChars: undefined },
    maxContextChars: 3000,
  });
  let seenTurns = null;
  const result = await interpretTask({
    prompt: "继续",
    state: ledger,
    config: cfg,
    conversation: Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `历史消息${i}`.padEnd(800, "话"),
    })),
    agentClassifier: {
      model: "host/model",
      complete: async ({ payload: sent }) => {
        seenTurns = JSON.parse(sent).conversation.length;
        assert.ok(sent.length <= 3000, `shrunk payload ${sent.length}`);
        return JSON.stringify(valid);
      },
    },
    fetcher: () => assert.fail("must not call endpoint"),
  });
  assert.equal(result.reason, "contextual");
  assert.ok(seenTurns < 12, `conversation shrunk to ${seenTurns}`);
  assert.ok(result.contextChars <= 3000);
});
