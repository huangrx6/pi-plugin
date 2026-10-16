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
    usage: { output: 10 },
    stopReason: "stop",
  });
  assert.ok(sample);
  assert.equal(sample.ttftMs, 120);
  assert.equal(sample.streamMs, 1080);
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

test("an empty response with no deltas is not recordable", () => {
  const { tracker, set } = clocked();
  tracker.start({});
  set(10);
  assert.equal(tracker.finish({ role: "assistant", usage: { output: 0 } }), null);
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
