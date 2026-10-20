import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStatusText,
  contentChars,
  formatLatency,
  formatTokens,
  formatTps,
  isTicking,
  sampleTps,
  tokenCount,
  waitingMs,
} from "../format.ts";
import { EMPTY_TOTALS, addCall, addTool, overlayLive } from "../session.ts";
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

test("the status cell shows the four session metrics even before any call", () => {
  assert.equal(
    buildStatusText(EMPTY_TOTALS, live({ phase: "idle" }), DEFAULTS, 0),
    "llm: -- · tools: -- · ttft: -- · rate: --",
  );
});

test("a finished call feeds the four metrics and they stay on screen", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  const done = live({ phase: "done", tokens: 100, firstDeltaAt: 400, endedAt: 2400 });
  assert.equal(
    buildStatusText(totals, done, DEFAULTS, 2400),
    "llm: 2.4s · tools: -- · ttft: 400ms · rate: 50.0 t/s",
  );
  // agent_end 不再清空：同一份累计值继续渲染。
  assert.equal(
    buildStatusText(totals, live({ phase: "idle" }), DEFAULTS, 9_999),
    "llm: 2.4s · tools: -- · ttft: 400ms · rate: 50.0 t/s",
  );
});

test("tool time joins the same line as its own persistent metric", () => {
  const totals = addTool(addCall(EMPTY_TOTALS, sample()), 65_000);
  assert.equal(
    buildStatusText(totals, live({ phase: "idle" }), DEFAULTS, 0),
    "llm: 2.4s · tools: 1m5s · ttft: 400ms · rate: 50.0 t/s",
  );
});

test("the waiting suffix is appended without hiding the persistent metrics", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  const waiting = buildStatusText(totals, live({ phase: "waiting", startedAt: 1000 }), DEFAULTS, 4200);
  // 在飞调用也已计入模型用时：2.4s（已完成） + 3.2s（本次等待）
  assert.equal(waiting, "llm: 5.6s · tools: -- · ttft: 400ms · rate: 50.0 t/s · wait 3.2s");
  assert.equal(waitingMs(live({ phase: "waiting", startedAt: 1000 }), 4200), 3200);
  assert.equal(waitingMs(live({ firstDeltaAt: 500, startedAt: 1000 }), 4200), null);
});

test("an in-flight call moves model time and, once the window is usable, the rate", () => {
  const totals = addCall(EMPTY_TOTALS, sample());
  const streaming = live({ tokens: 20, startedAt: 0, firstDeltaAt: 400 });
  // 窗口不足 minWindowMs 时只叠模型用时，不把噪声算进速率。
  const early = buildStatusText(totals, streaming, DEFAULTS, 600);
  assert.equal(early, "llm: 3.0s · tools: -- · ttft: 400ms · rate: 50.0 t/s");
  // 120 token ÷（2000ms + 1100ms 在飞窗口）
  const steady = buildStatusText(totals, streaming, DEFAULTS, 1500);
  assert.equal(steady, "llm: 3.9s · tools: -- · ttft: 400ms · rate: 38.7 t/s");
  const overlay = overlayLive(totals, streaming, "stream", 1500, DEFAULTS.minWindowMs);
  assert.equal(overlay.streamTokens, 120);
  assert.equal(overlay.streamMs, 3100);
});

test("the wait timer converts units instead of counting seconds forever", () => {
  const long = buildStatusText(EMPTY_TOTALS, live({ phase: "waiting", startedAt: 0 }), DEFAULTS, 95_000);
  assert.equal(long, "llm: 1m35s · tools: -- · ttft: -- · rate: -- · wait 1m35s");
  assert.equal(isTicking(live({ phase: "waiting", startedAt: 0 }), 95_000), true);
});

test("the display mode narrows the same session metrics", () => {
  const totals = addTool(addCall(EMPTY_TOTALS, sample()), 65_000);
  assert.equal(
    buildStatusText(totals, live({ phase: "idle" }), { ...DEFAULTS, display: "tps" }, 0),
    "rate: 50.0 t/s",
  );
  assert.equal(
    buildStatusText(totals, live({ phase: "idle" }), { ...DEFAULTS, display: "ttft" }, 0),
    "ttft: 400ms",
  );
});

test("the ticker only runs while the wait timer is on screen", () => {
  assert.equal(isTicking(live({ phase: "waiting", startedAt: 0 }), 10), true);
  assert.equal(isTicking(live({ tokens: 20, firstDeltaAt: 400 }), 600), false);
  assert.equal(isTicking(live({ phase: "done", tokens: 0, firstDeltaAt: null, endedAt: 10 }), 20), false);
});

test("buildStatusText never exceeds the status width", () => {
  const totals = addTool(
    addCall(EMPTY_TOTALS, sample({ tokens: 123_456, streamMs: 1200, e2eMs: 3_900_000, ttftMs: 3_600_000 })),
    3_900_000,
  );
  const text = buildStatusText(totals, doneWithLongModel(), DEFAULTS, 2400);
  assert.ok(displayWidth(text) <= 72);
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
