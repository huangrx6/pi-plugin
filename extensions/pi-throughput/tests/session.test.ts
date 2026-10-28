import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLE_TYPE, TOOL_SAMPLE_TYPE } from "../constants.ts";
import {
  EMPTY_TOTALS,
  addCall,
  addTool,
  deriveMetrics,
  totalsFromEntries,
} from "../session.ts";
import type { LiveState, ThroughputSample } from "../types.ts";

function sample(overrides: Partial<ThroughputSample> = {}): ThroughputSample {
  return {
    at: 1_700_000_000_000,
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    tokens: 100,
    streamTokens: overrides.tokens ?? 100,
    estimated: false,
    ttftMs: 400,
    streamMs: 2000,
    e2eMs: 2400,
    aborted: false,
    ...overrides,
  };
}

function live(overrides: Partial<LiveState> = {}): LiveState {
  return {
    phase: "streaming",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    tokens: 0,
    estimated: false,
    startedAt: 0,
    firstDeltaAt: null,
    endedAt: null,
    ...overrides,
  };
}

test("addCall accumulates model time, decode window and TTFT", () => {
  const totals = addCall(addCall(EMPTY_TOTALS, sample()), sample({ tokens: 300, streamMs: 1000, e2eMs: 1400, ttftMs: 200 }));
  assert.equal(totals.calls, 2);
  assert.equal(totals.llmMs, 3800);
  assert.equal(totals.streamTokens, 400);
  assert.equal(totals.streamMs, 3000);
  assert.equal(totals.ttftMs, 600);
  assert.equal(totals.ttftSteps, 2);
});

test("a call without first token still spends model time but no decode rate", () => {
  const totals = addCall(EMPTY_TOTALS, sample({ ttftMs: null, streamMs: null, tokens: 0 }));
  assert.equal(totals.llmMs, 2400);
  assert.equal(totals.streamMs, 0);
  assert.equal(totals.streamTokens, 0);
  assert.equal(totals.ttftSteps, 0);
  assert.equal(deriveMetrics(totals, "stream").tps, null);
});

test("an empty call is counted even when the measured duration rounds to zero", () => {
  const totals = addCall(EMPTY_TOTALS, sample({ tokens: 0, e2eMs: 0, streamMs: null, ttftMs: null }));
  assert.equal(totals.calls, 1);
  assert.equal(totals.llmMs, 0);
  assert.equal(totals.ttftSteps, 0);
});

test("a cleaned-up call is counted but adds no wall time or decode window", () => {
  const totals = addCall(EMPTY_TOTALS, sample({ aborted: true }));
  assert.equal(totals.calls, 1);
  assert.equal(totals.llmMs, 0);
  assert.equal(totals.ttftSteps, 0);
  assert.equal(totals.streamTokens, 0);
  assert.equal(deriveMetrics(totals, "stream").tps, null);
});

test("estimated tokens never enter the session rate", () => {
  const totals = addCall(EMPTY_TOTALS, sample({ estimated: true }));
  // 模型用时与首 token 跟用量无关，照常计入。
  assert.equal(totals.llmMs, 2400);
  assert.equal(totals.ttftSteps, 1);
  // Σ/Σ 只用 provider 上报的 token，估算值只随样本保留。
  assert.equal(totals.streamTokens, 0);
  assert.equal(totals.streamMs, 0);
  assert.equal(deriveMetrics(totals, "stream").tps, null);
});

test("addTool only accepts usable durations", () => {
  assert.equal(addTool(EMPTY_TOTALS, 1500).toolMs, 1500);
  assert.equal(addTool(EMPTY_TOTALS, 0).toolMs, 0);
  assert.equal(addTool(EMPTY_TOTALS, Number.NaN).toolMs, 0);
  assert.equal(addTool(EMPTY_TOTALS, -5).toolMs, 0);
  assert.equal(addTool(EMPTY_TOTALS, "1200").toolMs, 0);
});

test("the e2e denominator counts from the request anchor", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  assert.equal(deriveMetrics(totals, "e2e").tps, (100 / 2400) * 1000);
  assert.equal(deriveMetrics(totals, "stream").tps, (100 / 2000) * 1000);
});

test("deriveMetrics reports -- placeholders until data exists", () => {
  assert.deepEqual(deriveMetrics(EMPTY_TOTALS, "stream"), {
    llmMs: null,
    toolMs: null,
    ttftMs: null,
    tps: null,
  });
  const totals = addTool(addCall(EMPTY_TOTALS, sample()), 65_000);
  const metrics = deriveMetrics(totals, "stream");
  assert.equal(metrics.llmMs, 2400);
  assert.equal(metrics.toolMs, 65_000);
  assert.equal(metrics.ttftMs, 400);
  assert.equal(metrics.tps, 50);
});

test("totalsFromEntries rebuilds the running figures from a session branch", () => {
  const totals = totalsFromEntries([
    { type: "custom", customType: SAMPLE_TYPE, data: sample() },
    { type: "custom", customType: TOOL_SAMPLE_TYPE, data: { at: 1, durationMs: 3000 } },
    { type: "custom", customType: TOOL_SAMPLE_TYPE, data: { at: 2, durationMs: -1 } },
    { type: "custom", customType: "other-extension", data: sample() },
    { type: "message", data: sample() },
    null,
    "garbage",
  ]);
  assert.equal(totals.calls, 1);
  assert.equal(totals.llmMs, 2400);
  assert.equal(totals.toolMs, 3000);
});

test("totalsFromEntries skips samples whose fields are unusable", () => {
  const totals = totalsFromEntries([
    { type: "custom", customType: SAMPLE_TYPE, data: { ...sample(), model: 42 } },
    { type: "custom", customType: SAMPLE_TYPE, data: { ...sample(), e2eMs: -1 } },
  ]);
  assert.deepEqual(totals, EMPTY_TOTALS);
});

test("old samples remain usable for e2e but never pretend to have body tokens", () => {
  const old = sample();
  delete old.streamTokens;
  const totals = totalsFromEntries([{ type: "custom", customType: SAMPLE_TYPE, data: old }]);
  assert.equal(deriveMetrics(totals, "stream").tps, null);
  assert.ok(Math.abs(deriveMetrics(totals, "e2e").tps! - 100 / 2.4) < 1e-10);
});

test("zero-output successes contribute elapsed time to the end-to-end denominator", () => {
  const totals = addCall(addCall(EMPTY_TOTALS, sample({ tokens: 100, e2eMs: 1000 })),
    sample({ tokens: 0, e2eMs: 1000, streamMs: null, ttftMs: null }));
  assert.equal(totals.calls, 2);
  assert.equal(totals.llmMs, 2000);
  assert.equal(deriveMetrics(totals, "e2e").tps, 50);
});

test("branch restoration rejects the same malformed samples as the stats panel", () => {
  const entries = [
    { type: "custom", customType: SAMPLE_TYPE, data: sample({ ttftMs: -1 }) },
    { type: "custom", customType: SAMPLE_TYPE, data: sample({ streamTokens: 101 }) },
    { type: "custom", customType: SAMPLE_TYPE, data: sample({ e2eMs: Number.POSITIVE_INFINITY }) },
  ];
  assert.deepEqual(totalsFromEntries(entries), EMPTY_TOTALS);
});

test("totalsFromEntries counts rounds and steps from message entries", () => {
  const totals = totalsFromEntries([
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "user" } },
  ]);
  assert.equal(totals.rounds, 2);
  assert.equal(totals.steps, 2);
});
