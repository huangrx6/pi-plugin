import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatusText,
  contentChars,
  formatLatency,
  formatTokens,
  formatTps,
  isTicking,
  liveTps,
  sampleTps,
  tokenCount,
} from "../format.ts";
import { DEFAULT_MIN_WINDOW_MS } from "../constants.ts";
import { displayWidth, sanitizeTerminalText, truncateToWidth } from "../ui.ts";
import { DEFAULTS } from "../config.ts";
import type { LiveState, ThroughputSample } from "../types.ts";

function live(overrides: Partial<LiveState> = {}): LiveState {
  return {
    phase: "streaming",
    provider: "p",
    model: "m",
    tokens: 0,
    estimated: false,
    startedAt: 0,
    firstDeltaAt: null,
    endedAt: null,
    ...overrides,
  };
}

function sample(overrides: Partial<ThroughputSample> = {}): ThroughputSample {
  return {
    at: 1_700_000_000_000,
    provider: "p",
    model: "m",
    tokens: 100,
    estimated: false,
    ttftMs: 400,
    streamMs: 2000,
    e2eMs: 2400,
    aborted: false,
    ...overrides,
  };
}

test("tokenCount prefers provider usage and falls back to a type-aware estimate", () => {
  assert.deepEqual(tokenCount({ usage: { output: 42 } }), { tokens: 42, estimated: false });
  const estimate = tokenCount({ content: [{ type: "text", text: "12345678" }] });
  assert.deepEqual(estimate, { tokens: 3, estimated: true });
});

test("tokenCount estimates CJK as one token per character", () => {
  // 旧口径「字符 ÷ 4」把 8 个汉字算成 2 token，流中 rate 因此系统性偏低。
  assert.deepEqual(tokenCount({ content: [{ type: "text", text: "入口入口入口入口" }] }), {
    tokens: 8,
    estimated: true,
  });
  const mixed = tokenCount({ content: [{ type: "text", text: "入口abcd" }] });
  assert.equal(mixed.tokens, 2 + Math.ceil(4 / 3.5));
});

test("tokenCount treats zero and missing usage as estimated", () => {
  assert.equal(tokenCount({ usage: { output: 0 }, content: [{ type: "text", text: "abcd" }] }).estimated, true);
  assert.equal(tokenCount(undefined).tokens, 0);
});

test("contentChars counts text, thinking and toolcall arguments", () => {
  const chars = contentChars({
    content: [
      { type: "text", text: "abcd" },
      { type: "thinking", thinking: "efg" },
      { type: "toolCall", arguments: { a: 1 } },
      { type: "image" },
    ],
  });
  assert.equal(chars, 4 + 3 + JSON.stringify({ a: 1 }).length);
});

test("contentChars survives circular tool arguments", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(contentChars({ content: [{ type: "toolCall", arguments: circular }] }), 0);
});

test("number formatting keeps the status bar stable", () => {
  assert.equal(formatTps(42.14), "42.1");
  assert.equal(formatTps(142.6), "143");
  assert.equal(formatTps(0), "--");
  assert.equal(formatLatency(412.4), "412ms");
  assert.equal(formatLatency(1850), "1.9s");
  assert.equal(formatLatency(42_400), "42s");
  assert.equal(formatLatency(65_000), "1m5s");
  assert.equal(formatLatency(120_000), "2m");
  assert.equal(formatLatency(3_900_000), "1h5m");
  assert.equal(formatLatency(-1), "--");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_345), "12.3k");
});

test("sampleTps follows the selected denominator", () => {
  assert.equal(sampleTps(sample(), "stream"), 50);
  assert.equal(sampleTps(sample(), "e2e"), (100 / 2400) * 1000);
  assert.equal(sampleTps(sample({ streamMs: null }), "stream"), null);
  assert.equal(sampleTps(sample({ tokens: 0 }), "e2e"), null);
});

test("liveTps gates the mid-stream window but not the final value", () => {
  const streaming = live({ tokens: 10, firstDeltaAt: 400, endedAt: null });
  assert.equal(liveTps(streaming, "stream", 500, DEFAULT_MIN_WINDOW_MS), null);
  assert.equal(liveTps(streaming, "stream", 1000, DEFAULT_MIN_WINDOW_MS), 10 / 0.6);
  const done = live({ phase: "done", tokens: 10, firstDeltaAt: 400, endedAt: 500 });
  assert.equal(liveTps(done, "stream", 9999, DEFAULT_MIN_WINDOW_MS), 100);
});

test("liveTps uses the request anchor for the e2e denominator", () => {
  const state = live({ tokens: 100, firstDeltaAt: 400, endedAt: 2400 });
  assert.equal(liveTps(state, "e2e", 0, DEFAULT_MIN_WINDOW_MS), (100 / 2400) * 1000);
});

test("buildStatusText counts the wait, then shows live and final values", () => {
  const waiting = buildStatusText(live({ phase: "waiting", startedAt: 1000 }), DEFAULTS, 4200);
  assert.equal(waiting, "ttft: waiting 3.2s");
  const streaming = buildStatusText(
    live({ tokens: 20, firstDeltaAt: 400 }),
    DEFAULTS,
    1500,
  );
  assert.equal(streaming, "rate: 18.2 t/s ttft: 400ms");
  const done = buildStatusText(
    live({ phase: "done", tokens: 100, firstDeltaAt: 400, endedAt: 2400 }),
    DEFAULTS,
    2400,
  );
  assert.equal(done, "rate: 50.0 t/s ttft: 400ms");
});

test("buildStatusText shows only the metrics that exist yet", () => {
  const warmUp = live({ tokens: 20, firstDeltaAt: 400 });
  assert.equal(buildStatusText(warmUp, DEFAULTS, 600), "ttft: 400ms");
  assert.equal(buildStatusText(warmUp, { ...DEFAULTS, display: "tps" }, 600), null);
  assert.equal(buildStatusText(warmUp, { ...DEFAULTS, display: "ttft" }, 600), "ttft: 400ms");
});

test("the wait timer converts units instead of counting seconds forever", () => {
  const long = buildStatusText(live({ phase: "waiting", startedAt: 0 }), DEFAULTS, 95_000);
  assert.equal(long, "ttft: waiting 1m35s");
  assert.equal(isTicking(live({ phase: "waiting", startedAt: 0 }), DEFAULTS, 95_000), true);
});

test("buildStatusText honours the display mode and stays silent when idle", () => {
  const done = live({ phase: "done", tokens: 100, firstDeltaAt: 400, endedAt: 2400 });
  assert.equal(buildStatusText(done, { ...DEFAULTS, display: "tps" }, 2400), "rate: 50.0 t/s");
  assert.equal(buildStatusText(done, { ...DEFAULTS, display: "ttft" }, 2400), "ttft: 400ms");
  assert.equal(buildStatusText(live({ phase: "idle" }), DEFAULTS, 0), "rate: -- ttft: --");
});

test("the ticker only runs while the wait timer owns the cell", () => {
  assert.equal(isTicking(live({ phase: "waiting", startedAt: 0 }), DEFAULTS, 10), true);
  assert.equal(isTicking(live({ tokens: 20, firstDeltaAt: 400 }), DEFAULTS, 600), false);
  assert.equal(isTicking(live({ tokens: 20, firstDeltaAt: 400 }), { ...DEFAULTS, display: "tps" }, 600), false);
  assert.equal(isTicking(live({ phase: "done", tokens: 0, firstDeltaAt: null, endedAt: 10 }), DEFAULTS, 20), false);
});

test("buildStatusText never exceeds the status width", () => {
  const text = buildStatusText(doneWithLongModel(), DEFAULTS, 2400);
  assert.notEqual(text, null);
  assert.ok(displayWidth(text ?? "") <= 72);
});

test("terminal text helpers strip control codes and measure CJK double width", () => {
  assert.equal(sanitizeTerminalText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeTerminalText("\u001b]0;title\u0007x"), "x");
  assert.equal(displayWidth("入口"), 4);
  assert.equal(truncateToWidth("abcdef", 4), "abc…");
  assert.equal(truncateToWidth("入口入口", 4), "入…");
});

function doneWithLongModel(): LiveState {
  return live({
    phase: "done",
    provider: "provider-with-a-long-name",
    model: "a-very-long-model-identifier-that-would-overflow-the-status-bar",
    tokens: 123_456,
    firstDeltaAt: 400,
    endedAt: 2400,
  });
}
