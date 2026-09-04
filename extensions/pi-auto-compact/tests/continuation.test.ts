import assert from "node:assert/strict";
import test from "node:test";
import { changedInstructions, CompactionContinuation, type CompactionNotice, type ContinuationContext } from "../continuation.ts";

test("continuation carries only the changed system instruction block", () => {
  assert.equal(changedInstructions("Base\nActive constraint", "Base"), "Active constraint");
  assert.equal(changedInstructions("Prefix\nConstraint\nSuffix", "Prefix\nSuffix"), "Constraint");
  assert.equal(changedInstructions("Base", "Base"), "");
  assert.equal(changedInstructions("Prefix\nNew rule\nSuffix", "Prefix\nOld rule\nSuffix"), "New rule");
  assert.equal(changedInstructions("Base\nActive constraint", ""), "Base\nActive constraint", "unknown baseline preserves all effective instructions");
});

function harness() {
  const notices: CompactionNotice[] = [];
  const resumed: string[] = [];
  let calls = 0;
  let options: Parameters<ContinuationContext["compact"]>[0];
  const state = { idle: false, pending: false, session: "one" };
  const ctx: ContinuationContext = {
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    sessionManager: { getSessionId: () => state.session },
    compact: value => { calls++; options = value; },
  };
  const flow = new CompactionContinuation(value => resumed.push(value), value => notices.push(value));
  return { flow, ctx, state, notices, resumed, calls: () => calls,
    complete() { state.idle = true; options.onComplete({ tokensBefore: 1000, estimatedTokensAfter: 300 }); },
    fail() { options.onError(new Error("Compaction cancelled")); } };
}

test("successful maintenance resumes the interrupted objective exactly once", () => {
  const h = harness();
  assert.equal(h.flow.request(h.ctx, "fix login"), true);
  assert.equal(h.flow.request(h.ctx, "fix login"), false);
  h.complete(); h.complete();
  assert.deepEqual(h.resumed, ["fix login"]);
  assert.equal(h.notices[0]?.tokensAfter, 300);
  assert.ok(Object.isFrozen(h.notices[0]), "recorded maintenance facts are immutable snapshots");
  h.state.idle = false;
  assert.equal(h.flow.request(h.ctx, "fix login"), false, "no loop when compaction did not lower pressure");
  h.flow.observePressure(false);
  assert.equal(h.flow.request(h.ctx, "fix login"), true);
});

test("cancellation/failure never resumes or automatically retries", () => {
  const h = harness(); h.flow.request(h.ctx, "task"); h.fail(); h.complete();
  assert.deepEqual(h.resumed, []);
  assert.equal(h.notices[0]?.status, "failed");
  h.state.idle = false;
  assert.equal(h.flow.request(h.ctx, "task"), false);
});

test("new input, changed branch or shutdown invalidates completed callbacks", () => {
  const h = harness(); h.flow.request(h.ctx, "old task"); h.flow.invalidate(); h.complete();
  assert.deepEqual(h.resumed, []); assert.deepEqual(h.notices, []);
});

test("a changed session cannot be resumed even before its lifecycle event arrives", () => {
  const h = harness(); h.flow.request(h.ctx, "old task"); h.state.session = "two"; h.complete();
  assert.deepEqual(h.resumed, []);
});

test("pending user input wins over an automatic continuation", () => {
  const h = harness(); h.flow.request(h.ctx, "task"); h.state.pending = true; h.complete();
  assert.deepEqual(h.resumed, []); assert.equal(h.notices[0]?.status, "completed");
});

test("idle, already aborted and queued-input states never start maintenance", () => {
  const h = harness();
  h.state.idle = true; assert.equal(h.flow.request(h.ctx, "task"), false);
  h.state.idle = false; h.state.pending = true; assert.equal(h.flow.request(h.ctx, "task"), false);
  h.state.pending = false; h.ctx.signal = AbortSignal.abort(); assert.equal(h.flow.request(h.ctx, "task"), false);
  assert.equal(h.calls(), 0);
});
