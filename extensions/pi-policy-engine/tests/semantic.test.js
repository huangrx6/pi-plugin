// semantic.js unit tests: conservative merge contract (v0.16).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSemanticPrompt,
  buildSemanticRequestBody,
  maybeSemanticClassify,
} from "../src/core/semantic.js";

const det = (over = {}) => ({
  taskType: "coding",
  risk: "medium",
  domains: [],
  executionIntent: "mutate",
  confidence: 0.5,
  reasons: ["det baseline"],
  ...over,
});

const enabledCfg = (over = {}) => ({
  semanticFallback: {
    enabled: true,
    endpoint: "https://example.test/v1/chat/completions",
    model: "test-model",
    apiKeyEnvVar: "PI_POLICY_TEST_KEY",
    confidenceThreshold: 0.7,
    ...over,
  },
});

const okResponse = (payload) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }),
});

test("request body shape", () => {
  const body = buildSemanticRequestBody(
    "gpt-4o-mini",
    '{"prompt":"x","deterministic":{"taskType":"coding"}}',
  );
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.temperature, 0);
  assert.equal(body.response_format.type, "json_object");
});

test("prompt payload is valid JSON with deterministic hint", () => {
  const payload = buildSemanticPrompt("hi", det());
  const parsed = JSON.parse(payload);
  assert.equal(parsed.prompt, "hi");
  assert.equal(parsed.deterministic.taskType, "coding");
  // v0.16: the deterministic confidence is NOT sent — the model doesn't
  // get to arbitrate against a self-reported number.
  assert.equal(parsed.deterministic.confidence, undefined);
});

test("disabled by default — never makes a network call", async () => {
  const calls = [];
  const fetcher = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, json: () => ({}) });
  };
  const result = await maybeSemanticClassify(
    "修个 typo",
    det(),
    { semanticFallback: { enabled: false } },
    { fetcher },
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("enabled but confidence high — not invoked", async () => {
  const calls = [];
  const fetcher = () => {
    calls.push(1);
    return Promise.resolve({ ok: true });
  };
  const result = await maybeSemanticClassify(
    "fix a bug",
    det({ confidence: 0.95 }),
    enabledCfg(),
    { fetcher },
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("low confidence merges conservatively", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "我们线上 deploy 经常回滚",
    det({ risk: "medium", domains: [], executionIntent: "mutate" }),
    enabledCfg(),
    {
      fetcher: async () =>
        okResponse({
          taskType: "architecture",
          risk: "high",
          domains: ["database", "kubernetes"],
        }),
    },
  );
  assert.ok(merged);
  assert.equal(merged.taskType, "architecture");
  assert.equal(merged.risk, "high");
  assert.deepEqual(merged.domains, ["database", "kubernetes"]);
  assert.equal(merged.executionIntent, "mutate");
  // v0.16: confidence stays the ENGINE's deterministic number.
  assert.equal(merged.confidence, 0.5);
  assert.ok(merged.reasons.some((r) => r.startsWith("semantic-fallback:")));
  delete process.env.PI_POLICY_TEST_KEY;
});

test("risk can only go UP, never down (hard evidence rule)", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ risk: "high", domains: ["security"], executionIntent: "mutate" }),
    enabledCfg(),
    {
      fetcher: async () =>
        okResponse({
          taskType: "documentation",
          risk: "low",
          domains: ["frontend", "backend", "database"],
          executionIntent: "read-only",
        }),
    },
  );
  assert.equal(merged.risk, "high");
  assert.equal(merged.executionIntent, "mutate"); // locked (not unclear)
  // Deterministic security kept; hallucinated extras enum-filtered/capped.
  assert.deepEqual(merged.domains, ["security", "frontend"]);
  assert.equal(merged.confidence, 0.5); // model self-report ignored
  delete process.env.PI_POLICY_TEST_KEY;
});

test("hallucinated domains are enum-filtered before merge", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ domains: [] }),
    enabledCfg(),
    {
      fetcher: async () =>
        okResponse({
          taskType: "coding",
          risk: "medium",
          domains: ["made-up", "whatever", "backend"],
        }),
    },
  );
  assert.deepEqual(merged.domains, ["backend"]);
  assert.ok(!merged.reasons.some((r) => r.includes("made-up")));
  delete process.env.PI_POLICY_TEST_KEY;
});

test("intent resolved only when deterministic said unclear", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ executionIntent: "unclear" }),
    enabledCfg(),
    {
      fetcher: async () =>
        okResponse({
          taskType: "coding",
          risk: "medium",
          domains: [],
          executionIntent: "read-only",
        }),
    },
  );
  assert.equal(merged.executionIntent, "read-only");
  delete process.env.PI_POLICY_TEST_KEY;
});

test("fetcher throws — null, deterministic stands", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ confidence: 0.4 }),
    enabledCfg(),
    {
      fetcher: async () => {
        throw new Error("network down");
      },
    },
  );
  assert.equal(merged, null);
  delete process.env.PI_POLICY_TEST_KEY;
});

test("missing API key — null", async () => {
  delete process.env.PI_POLICY_TEST_KEY;
  const merged = await maybeSemanticClassify(
    "x",
    det({ confidence: 0.4 }),
    enabledCfg(),
  );
  assert.equal(merged, null);
});

test("response not ok — null", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ confidence: 0.4 }),
    enabledCfg(),
    {
      fetcher: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    },
  );
  assert.equal(merged, null);
  delete process.env.PI_POLICY_TEST_KEY;
});

test("invalid schema — null", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ confidence: 0.4 }),
    enabledCfg(),
    { fetcher: async () => okResponse({ taskType: "wrong" }) },
  );
  assert.equal(merged, null);
  delete process.env.PI_POLICY_TEST_KEY;
});

test("v0.21: merge respects config.maxDomains", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const merged = await maybeSemanticClassify(
    "x",
    det({ domains: ["security"], confidence: 0.4 }),
    enabledCfg({ maxDomains: 1 }),
    {
      fetcher: async () =>
        okResponse({
          taskType: "coding",
          risk: "medium",
          domains: ["frontend", "backend"],
        }),
    },
  );
  assert.equal(merged.domains.length, 1, JSON.stringify(merged.domains));
  assert.deepEqual(merged.domains, ["security"]); // deterministic kept
  delete process.env.PI_POLICY_TEST_KEY;
});

test("v0.21: task-invariant risk floor re-applied post-merge", async () => {
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  // semantic flips coding→architecture but reports medium; the classifier's
  // own architecture→high invariant must hold after arbitration.
  const merged = await maybeSemanticClassify(
    "x",
    det({ taskType: "coding", risk: "medium", confidence: 0.4 }),
    enabledCfg(),
    {
      fetcher: async () =>
        okResponse({
          taskType: "architecture",
          risk: "medium",
          domains: [],
        }),
    },
  );
  assert.equal(merged.taskType, "architecture");
  assert.equal(merged.risk, "high");
  assert.ok(merged.reasons.some((r) => r.includes("task invariant")));
  delete process.env.PI_POLICY_TEST_KEY;
});
