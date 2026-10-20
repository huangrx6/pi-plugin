import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolClock } from "../toolclock.ts";

function fakeClock() {
  let current = 1000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("a dispatched call reports the wall time up to its result", () => {
  const clock = fakeClock();
  const tools = createToolClock(clock.now);
  tools.start("c1");
  clock.advance(1500);
  assert.equal(tools.end("c1"), 1500);
});

test("an unknown call id has no measurable span", () => {
  const tools = createToolClock(() => 0);
  assert.equal(tools.end("missing"), null);
});

test("the span is settled once and dropped from the in-flight set", () => {
  const clock = fakeClock();
  const tools = createToolClock(clock.now);
  tools.start("c1");
  clock.advance(20);
  assert.equal(tools.end("c1"), 20);
  clock.advance(500);
  assert.equal(tools.end("c1"), null);
});

test("parallel calls keep separate spans", () => {
  const clock = fakeClock();
  const tools = createToolClock(clock.now);
  tools.start("a");
  clock.advance(100);
  tools.start("b");
  clock.advance(50);
  assert.equal(tools.end("a"), 150);
  assert.equal(tools.end("b"), 50);
});

test("a re-dispatch restarts the span from the later start", () => {
  const clock = fakeClock();
  const tools = createToolClock(clock.now);
  tools.start("c1");
  clock.advance(900);
  tools.start("c1");
  clock.advance(100);
  assert.equal(tools.end("c1"), 100);
});

test("reset drops in-flight spans", () => {
  const tools = createToolClock(() => 0);
  tools.start("c1");
  tools.reset();
  assert.equal(tools.end("c1"), null);
});
