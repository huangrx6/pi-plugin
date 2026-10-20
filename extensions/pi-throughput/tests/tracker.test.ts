import assert from "node:assert/strict";
import { test } from "node:test";
import { createTracker } from "../tracker.ts";

function clocked(start = 0) {
  let value = start;
  const tracker = createTracker(() => value);
  return {
    tracker,
    set(ms: number) {
      value = ms;
    },
  };
}

test("one call produces TTFT, stream and e2e durations", () => {
  const { tracker, set } = clocked();
  tracker.start({ provider: "opencode-go", model: "deepseek-v4.1-flash" });
  set(120);
  tracker.update({
    type: "thinking_delta",
    partial: { content: [{ type: "thinking", thinking: "hmm" }] },
  });
  set(700);
  tracker.update({ type: "text_delta", partial: { content: [{ type: "text", text: "hi" }] } });
  set(1200);
  const sample = tracker.finish({
    role: "assistant",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    usage: { output: 10, reasoning: 4 },
    stopReason: "stop",
  });
  assert.ok(sample);
  assert.equal(sample.ttftMs, 120);
  assert.equal(sample.streamMs, 500);
  assert.equal(sample.streamTokens, 6);
  assert.equal(sample.e2eMs, 1200);
  assert.equal(sample.tokens, 10);
  assert.equal(sample.estimated, false);
  assert.equal(sample.aborted, false);
  assert.equal(sample.provider, "opencode-go");
});

test("a second start re-anchors instead of carrying the previous call", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(100);
  tracker.update({ type: "text_delta", partial: { usage: { output: 5 } } });
  set(200);
  tracker.finish({ role: "assistant", usage: { output: 5 }, stopReason: "toolUse" });
  tracker.start({ provider: "p", model: "m" });
  set(500);
  tracker.update({ type: "text_delta", partial: { usage: { output: 20 } } });
  set(900);
  const sample = tracker.finish({ role: "assistant", usage: { output: 20 }, stopReason: "stop" });
  assert.ok(sample);
  assert.equal(sample.ttftMs, 300);
  assert.equal(sample.e2eMs, 700);
});

test("an empty delta chunk does not anchor the first token", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(120);
  // provider 先发一个空帧开流：不能把它当首 token，否则 TTFT 会被算成 0。
  tracker.update({ type: "text_delta", delta: "", partial: { usage: { output: 0 } } });
  assert.equal(tracker.snapshot().firstDeltaAt, null);
  assert.equal(tracker.snapshot().phase, "waiting");
  set(900);
  tracker.update({ type: "text_delta", delta: "hi", partial: { content: [{ type: "text", text: "hi" }] } });
  assert.equal(tracker.snapshot().firstDeltaAt, 900);
  set(1200);
  const sample = tracker.finish({ role: "assistant", usage: { output: 5 }, stopReason: "stop" });
  assert.ok(sample);
  assert.equal(sample.ttftMs, 900);
});

test("non-delta events do not move the anchors", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(50);
  tracker.update({ type: "start", partial: { usage: { output: 1 } } });
  tracker.update({ type: "text_start", partial: { usage: { output: 1 } } });
  tracker.update(undefined);
  assert.equal(tracker.snapshot().firstDeltaAt, null);
  assert.equal(tracker.snapshot().tokens, 0);
});

test("an aborted call still yields a sample with a null-friendly timeline", () => {
  const { tracker, set } = clocked();
  tracker.start({ provider: "p", model: "m" });
  set(20);
  const sample = tracker.finish({ role: "assistant", usage: { output: 3 }, stopReason: "aborted" });
  assert.ok(sample);
  assert.equal(sample.ttftMs, null);
  assert.equal(sample.streamMs, null);
  assert.equal(sample.aborted, true);
});

test("finish without start is not recordable and resets to idle", () => {
  const { tracker } = clocked();
  assert.equal(tracker.finish({ role: "assistant", usage: { output: 9 } }), null);
  assert.equal(tracker.snapshot().phase, "idle");
});

test("an empty response still records its elapsed time and call count", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(10);
  const sample = tracker.finish({ role: "assistant", usage: { output: 0 } });
  assert.ok(sample);
  assert.equal(sample.tokens, 0);
  assert.equal(sample.e2eMs, 10);
  assert.equal(sample.ttftMs, null);
  assert.equal(sample.estimated, false);
});

test("late deltas after finish are ignored", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(100);
  tracker.update({ type: "text_delta", partial: { usage: { output: 5 } } });
  set(200);
  const sample = tracker.finish({ role: "assistant", usage: { output: 5 }, stopReason: "stop" });
  assert.ok(sample);
  tracker.update({ type: "text_delta", partial: { usage: { output: 99 } } });
  assert.equal(tracker.snapshot().tokens, 5);
});

test("reset returns the tracker to idle", () => {
  const { tracker } = clocked();
  tracker.start({ provider: "p", model: "m" });
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), {
    phase: "idle",
    provider: "",
    model: "",
    tokens: 0,
    estimated: false,
    startedAt: null,
    firstDeltaAt: null,
    endedAt: null,
  });
});

test("hidden reasoning tokens are excluded from the body transfer numerator", () => {
  const { tracker, set } = clocked();
  tracker.start({ provider: "p", model: "m" });
  set(10_000);
  tracker.update({ type: "text_delta", delta: "answer" });
  set(11_000);
  const sample = tracker.finish({ role: "assistant", usage: { output: 1000, reasoning: 900 } });
  assert.ok(sample);
  assert.equal(sample.streamTokens, 100);
  assert.equal(sample.streamMs, 1000);
  assert.equal(sample.e2eMs, 11_000);
});

test("thinking without a trustworthy token split cannot produce a body transfer rate", () => {
  for (const reasoning of [undefined, 0, -1, Number.NaN, 101]) {
    const { tracker, set } = clocked();
    tracker.start({});
    set(100);
    tracker.update({ type: "thinking_delta", delta: "thinking" });
    set(500);
    tracker.update({ type: "text_delta", delta: "answer" });
    set(1500);
    const sample = tracker.finish({ role: "assistant", usage: { output: 100, reasoning } });
    assert.ok(sample);
    assert.equal(sample.ttftMs, 100);
    assert.equal(sample.streamMs, 1000);
    assert.equal(sample.streamTokens, null);
    assert.equal(sample.tokens, 100);
  }
});

test("a tool-only answer has its own non-thinking stream window", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(100);
  tracker.update({ type: "toolcall_delta", delta: '{"path":' });
  set(500);
  const sample = tracker.finish({ role: "assistant", usage: { output: 20 }, stopReason: "toolUse" });
  assert.ok(sample);
  assert.equal(sample.streamTokens, 20);
  assert.equal(sample.streamMs, 400);
});

test("failure and cancellation before the first token are recorded exactly once", () => {
  for (const stopReason of ["error", "aborted"]) {
    const { tracker, set } = clocked();
    tracker.start({ provider: "p", model: "m" });
    set(5000);
    const message = { role: "assistant", usage: { output: 0 }, stopReason };
    const sample = tracker.finish(message);
    assert.ok(sample);
    assert.equal(sample.aborted, true);
    assert.equal(sample.e2eMs, 5000);
    assert.equal(sample.ttftMs, null);
    assert.equal(tracker.finish(message), null);
  }
});
