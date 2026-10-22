import assert from "node:assert/strict";
import test from "node:test";
import { addMetric, cacheHit, outputRate, refreshContext, snapshotFromEntries, usageTotal } from "../data.ts";
import { emptySnapshot } from "../types.ts";
import { createMeter, METRIC_TYPE, parseMetric } from "../metrics.ts";

test("current branch aggregation includes all host usage categories and weighted cache ratio", () => {
  const s = snapshotFromEntries([
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 900, output: 50 } } },
    { type: "message", message: { role: "assistant", usage: { input: 900, cacheRead: 100, output: 50 } } },
    { type: "compaction", usage: { input: 100, cacheWrite: 100 } },
    { type: "branch_summary", usage: { output: 20 } },
    { type: "usage", usage: { cacheRead: 200, cost: { total: 0.2 } } },
    { type: "message", message: { role: "toolResult", usage: { input: 30 } } },
    { type: "custom", customType: "unknown", data: { ms: 100 } },
  ]);
  assert.equal(s.rounds, 1); assert.equal(s.steps, 2);
  assert.equal(usageTotal(s), 2550); assert.equal(s.usage.cost, 0.2);
  assert.equal(cacheHit(s), 1200 / 2430 * 100);
  assert.equal(s.metrics.calls, 0); assert.equal(outputRate(s), null);
});
test("speed excludes first-token wait and weights successful calls by generation time", () => {
  const s = emptySnapshot();
  for (const sample of [
    { version: 1, kind: "call", ms: 1000, ttft: 100, output: 200, failed: false },
    { version: 1, kind: "call", ms: 3000, ttft: 300, output: 200, failed: false },
    { version: 1, kind: "call", ms: 1000, ttft: null, output: 0, failed: false },
    { version: 1, kind: "call", ms: 9000, ttft: null, output: null, failed: false },
    { version: 1, kind: "call", ms: 500, ttft: 50, output: 900, failed: true },
  ]) addMetric(s, parseMetric(sample)!);
  assert.ok(Math.abs(outputRate(s)! - 400 / 3.6) < 1e-9); assert.equal(s.metrics.llmMs, 14000);
  assert.equal(s.metrics.rateTokens, 400); assert.equal(s.metrics.rateMs, 3600);
  assert.equal(s.metrics.ttftMs / s.metrics.ttftCount, 200); assert.equal(s.metrics.failed, 1);
});
test("speed requires measured first content, at least 100 tokens and a 100ms generation window", () => {
  for (const values of [
    { ms: 1000, ttft: null, output: 200 },
    { ms: 1000, ttft: 100, output: null },
    { ms: 1000, ttft: 100, output: 0 },
    { ms: 1000, ttft: 100, output: 99 },
    { ms: 1000, ttft: 901, output: 200 },
    { ms: 1000, ttft: 1000, output: 200 },
    { ms: 0, ttft: 0, output: 200 },
  ]) {
    const s = emptySnapshot();
    addMetric(s, parseMetric({ version: 1, kind: "call", ...values, failed: false })!);
    assert.equal(outputRate(s), null, JSON.stringify(values));
    assert.equal(s.metrics.rateTokens, 0); assert.equal(s.metrics.rateMs, 0);
    assert.equal(s.metrics.llmMs, values.ms);
  }
  const s = emptySnapshot();
  addMetric(s, { version: 1, kind: "call", ms: 1000, ttft: 900, output: 100, failed: false });
  assert.equal(outputRate(s), 1000);
  const immediate = emptySnapshot();
  addMetric(immediate, { version: 1, kind: "call", ms: 1000, ttft: 0, output: 100, failed: false });
  assert.equal(outputRate(immediate), 100);
});
test("saved measurements rebuild speed without first-token wait or tool execution time", () => {
  const s = snapshotFromEntries([
    { type: "custom", customType: METRIC_TYPE, data: { version: 1, kind: "call", ms: 4000, ttft: 3000, output: 200, failed: false } },
    { type: "custom", customType: METRIC_TYPE, data: { version: 1, kind: "call", ms: 5000, ttft: 1000, output: 400, failed: false } },
    { type: "custom", customType: METRIC_TYPE, data: { version: 1, kind: "tool", ms: 10000 } },
  ]);
  assert.equal(outputRate(s), 120);
  assert.equal(s.metrics.llmMs, 9000); assert.equal(s.metrics.toolMs, 10000);
  assert.equal(s.metrics.ttftMs / s.metrics.ttftCount, 2000);
});
test("monotonic meter includes retry wait, thinking TTFT, tool dispatch and lifecycle reset", () => {
  let now = 0; const meter = createMeter(() => now);
  meter.start(); now = 300; meter.start(); meter.delta({ type: "text_delta", delta: "" });
  assert.equal(meter.waiting(), 300);
  now = 500; meter.delta({ type: "thinking_delta", delta: "思考" }); assert.equal(meter.waiting(), null);
  now = 2000;
  assert.deepEqual(meter.finish({ usage: { output: 250 } }), { version: 1, kind: "call", ms: 2000, ttft: 500, output: 250, failed: false });
  assert.equal(meter.finish({}), null);
  meter.toolStart("a"); now = 3000; meter.toolStart("b"); now = 5000;
  assert.equal(meter.toolEnd("a")?.ms, 3000); assert.equal(meter.toolEnd("b")?.ms, 2000);
  meter.start(); meter.reset(); assert.equal(meter.finish({}), null);
});
test("persisted malformed measurements and nonfinite usage cannot poison totals", () => {
  for (const v of [null, {}, { version: 1, kind: "tool", ms: -1 }, { version: 1, kind: "call", ms: 1, ttft: 2, output: 10, failed: false }]) assert.equal(parseMetric(v), null);
  const s = snapshotFromEntries([{ type: "message", message: { role: "assistant", usage: { input: NaN, output: Infinity, cacheRead: -1 } } },
    { type: "custom", customType: METRIC_TYPE, data: { version: 1, kind: "tool", ms: 20 } }]);
  assert.equal(usageTotal(s), 0); assert.equal(s.metrics.toolMs, 20);
});
test("context comes from coherent total and capacity; unknown is not zero", () => {
  const s = emptySnapshot(), ctx = { sessionManager: { getBranch: () => [] }, model: { id: "model\x1b]9;bad\x07", contextWindow: 1000 }, getContextUsage: () => ({ tokens: 166, contextWindow: 1000, percent: 99 }) };
  refreshContext(s, ctx); assert.equal(s.context?.percent, 16.6); assert.equal(s.model, "model");
  ctx.getContextUsage = () => ({ tokens: null, contextWindow: 1000, percent: null });
  refreshContext(s, ctx); assert.equal(s.context?.percent, null); assert.equal(s.context?.tokens, null);
});
test("duplicate tool completion cannot inflate timing even when a fallback is supplied", () => {
  let now = 0; const meter = createMeter(() => now);
  meter.toolStart("tool"); now = 10;
  assert.equal(meter.toolEnd("tool", 5)?.ms, 10);
  assert.equal(meter.toolEnd("tool", 5), null);
  meter.reset(); assert.equal(meter.toolEnd("next", 0)?.ms, 0);
});
