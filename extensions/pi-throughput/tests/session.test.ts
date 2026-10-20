import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLE_TYPE, TOOL_SAMPLE_TYPE } from "../constants.ts";
import {
  EMPTY_TOTALS,
  addCall,
  addTool,
  deriveMetrics,
  overlayLive,
  totalsFromEntries,
} from "../session.ts";
import type { LiveState, ThroughputSample } from "../types.ts";

function sample(overrides: Partial<ThroughputSample> = {}): ThroughputSample {
  return {
    at: 1_700_000_000_000,
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    tokens: 100,
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

test("a call with neither tokens nor measured time does not inflate counts", () => {
  assert.deepEqual(addCall(EMPTY_TOTALS, sample({ tokens: 0, e2eMs: 0 })), EMPTY_TOTALS);
});

test("addTool only accepts usable durations", () => {
  assert.equal(addTool(EMPTY_TOTALS, 1500).toolMs, 1500);
  assert.equal(addTool(EMPTY_TOTALS, 0).toolMs, 0);
  assert.equal(addTool(EMPTY_TOTALS, Number.NaN).toolMs, 0);
  assert.equal(addTool(EMPTY_TOTALS, -5).toolMs, 0);
  assert.equal(addTool(EMPTY_TOTALS, "1200").toolMs, 0);
});

test("overlayLive adds model time at once but gates the decode window", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  const streaming = live({ tokens: 20, firstDeltaAt: 400 });
  const early = overlayLive(totals, streaming, "stream", 600, 500);
  assert.equal(early.llmMs, 3000);
  assert.equal(early.streamTokens, 100);
  const steady = overlayLive(totals, streaming, "stream", 1500, 500);
  assert.equal(steady.streamTokens, 120);
  assert.equal(steady.streamMs, 3100);
});

test("overlayLive ignores finished and idle calls", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  assert.deepEqual(overlayLive(totals, live({ phase: "done" }), "stream", 9000, 500), totals);
  assert.deepEqual(overlayLive(totals, live({ phase: "idle", startedAt: null }), "stream", 9000, 500), totals);
});

test("the e2e denominator counts from the request anchor", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  assert.equal(deriveMetrics(totals, "e2e").tps, (100 / 2400) * 1000);
  const overlay = overlayLive(totals, live({ tokens: 50, firstDeltaAt: 400 }), "e2e", 2000, 500);
  assert.equal(overlay.e2eTokens, 150);
  assert.equal(overlay.e2eMs, 4400);
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
