import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretTask,
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
  semanticFallback: {
    enabled: true,
    strategy: "primary",
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
    assert.equal(r.source, "rules");
    assert.equal(r.reason, reason);
    assert.doesNotMatch(JSON.stringify(r), /private server secret/);
  }
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
      { task: { goal: "a".repeat(1100) } },
      "context_too_large",
    ],
  ]) {
    const r = await interpretTask({
      prompt: "继续",
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

test("semantic configuration rejects invalid strategy, protocol, and context budget", () => {
  for (const extra of [
    { strategy: "magic" },
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
