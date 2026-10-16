import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSummary,
  isSample,
  parseSamples,
  percentile,
  summarize,
} from "../stats.ts";
import { SAMPLE_TYPE } from "../constants.ts";
import type { ThroughputSample } from "../types.ts";

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

function entry(data: unknown) {
  return { type: "custom", customType: SAMPLE_TYPE, data };
}

test("percentile uses the nearest-rank method", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("parseSamples keeps only valid entries of this extension", () => {
  const samples = parseSamples([
    entry(sample()),
    entry({ ...sample(), model: 42 }),
    entry({ ...sample(), e2eMs: -1 }),
    { type: "custom", customType: "other-extension", data: sample() },
    { type: "message", data: sample() },
    null,
    "garbage",
  ]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.model, "deepseek-v4.1-flash");
});

test("parseSamples normalises missing booleans and preserves null durations", () => {
  const raw = { ...sample(), ttftMs: null, streamMs: null, estimated: undefined, aborted: undefined };
  const [parsed] = parseSamples([entry(raw)]);
  assert.ok(parsed);
  assert.equal(parsed.ttftMs, null);
  assert.equal(parsed.streamMs, null);
  assert.equal(parsed.estimated, false);
  assert.equal(parsed.aborted, false);
});

test("isSample rejects non-objects and incomplete data", () => {
  assert.equal(isSample(null), false);
  assert.equal(isSample({ model: "m" }), false);
  assert.equal(isSample(sample()), true);
});

test("parseSamples rejects negative durations instead of trusting them", () => {
  assert.equal(parseSamples([entry({ ...sample(), ttftMs: -5 })]).length, 0);
});

test("summarize groups by model and orders by call count", () => {
  const summary = summarize(
    [
      sample({ tokens: 100, streamMs: 1000 }),
      sample({ tokens: 300, streamMs: 1000 }),
      sample({ model: "glm-5.3", provider: "zai-coding-cn", tokens: 50, streamMs: 1000, aborted: true }),
    ],
    "stream",
  );
  assert.equal(summary.overall.calls, 3);
  assert.equal(summary.overall.aborted, 1);
  assert.equal(summary.overall.tokens, 450);
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byModel[0]?.model, "deepseek-v4.1-flash");
  assert.equal(summary.byModel[0]?.calls, 2);
  assert.equal(summary.byModel[0]?.avgTps, 200);
  assert.equal(summary.byModel[0]?.p95TtftMs, 400);
});

test("summarize reports null metrics when a call has no usable denominator", () => {
  const summary = summarize([sample({ streamMs: null })], "stream");
  assert.equal(summary.overall.avgTps, null);
  assert.equal(summary.overall.avgTtftMs, 400);
});

test("formatSummary distinguishes empty history from real aggregates", () => {
  const empty = formatSummary(summarize([], "stream"));
  assert.match(empty, /尚未记录调用样本/);
  const filled = formatSummary(summarize([sample()], "e2e"));
  assert.match(filled, /调用 1 次/);
  assert.match(filled, /端到端/);
  assert.match(filled, /deepseek-v4\.1-flash/);
  assert.match(filled, /⚡/);
});
