import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatusText,
  contentChars,
  formatLatency,
  formatTokens,
  formatTps,
  isPending,
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

test("tokenCount prefers provider usage and falls back to chars/4", () => {
  assert.deepEqual(tokenCount({ usage: { output: 42 } }), { tokens: 42, estimated: false });
  const estimate = tokenCount({ content: [{ type: "text", text: "12345678" }] });
  assert.deepEqual(estimate, { tokens: 2, estimated: true });
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
  assert.equal(formatLatency(1850), "1.85s");
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

test("buildStatusText renders a waiting placeholder, live values and the final value", () => {
  const waiting = buildStatusText(live({ phase: "waiting" }), DEFAULTS, 10);
  assert.equal(waiting, "⚡ … t/s · ⏱ …");
  const streaming = buildStatusText(
    live({ tokens: 20, firstDeltaAt: 400 }),
    DEFAULTS,
    1500,
  );
  assert.equal(streaming, "⚡ 18.2 t/s · ⏱ 400ms");
  const done = buildStatusText(
    live({ phase: "done", tokens: 100, firstDeltaAt: 400, endedAt: 2400 }),
    DEFAULTS,
    2400,
  );
  assert.equal(done, "⚡ 50.0 t/s · ⏱ 400ms");
});

test("buildStatusText honours the display mode and stays silent when idle", () => {
  const done = live({ phase: "done", tokens: 100, firstDeltaAt: 400, endedAt: 2400 });
  assert.equal(buildStatusText(done, { ...DEFAULTS, display: "tps" }, 2400), "⚡ 50.0 t/s");
  assert.equal(buildStatusText(done, { ...DEFAULTS, display: "ttft" }, 2400), "⏱ 400ms");
  assert.equal(buildStatusText(live({ phase: "idle" }), DEFAULTS, 0), null);
});

test("buildStatusText never exceeds the status width", () => {
  const text = buildStatusText(doneWithLongModel(), DEFAULTS, 2400);
  assert.notEqual(text, null);
  assert.ok(displayWidth(text ?? "") <= 72);
});

test("isPending covers waiting and first-delta-less phases", () => {
  assert.equal(isPending(live({ phase: "waiting" })), true);
  assert.equal(isPending(live({ phase: "streaming", firstDeltaAt: 10 })), false);
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
