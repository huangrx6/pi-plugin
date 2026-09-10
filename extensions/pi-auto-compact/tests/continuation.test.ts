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

test("user input between request and complete aborts resume (P2.2 microtask race)", () => {
  // 模拟 race：用户开始输入（invalidate 增 generation），此时 compact 刚好完成。
  // current() 检测到 generation 不一致，不续写；status=completed（不是 resumed）。
  const h = harness();
  assert.equal(h.flow.request(h.ctx, "fix login"), true);
  // 用户输入
  h.flow.invalidate();
  h.complete();
  // 不应续写；没有 resumed 通知
  assert.deepEqual(h.resumed, []);
  assert.equal(h.notices.length, 0, "race 下不应发任何 notice（generation 不一致，onComplete 早 return）");
});

test("user input after complete is allowed and race does not retroactively cancel (sanity check)", () => {
  // 正常完成 → 续写；之后用户输入不影响已发生的续写（generation 后续才变）。
  const h = harness();
  assert.equal(h.flow.request(h.ctx, "fix login"), true);
  h.complete();
  assert.deepEqual(h.resumed, ["fix login"]);
  assert.equal(h.notices[0]?.status, "resumed");
  // 用户后续输入
  h.flow.invalidate();
  // 已有 resumed 不回退
  assert.deepEqual(h.resumed, ["fix login"]);
});
