// approval.js unit tests: pure-approval grammar (v0.16 strip-based).
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyPlanResponse } from "../src/core/approval.js";

test("constraint-bearing approvals NEVER release execution", () => {
  const cases = [
    "批准，但是不要改数据库",
    "可以执行，不过只先做第一步",
    "通过，然而只改 README 部分",
    "批准，别忘了跑测试",
    "批准，执行时保持 API 兼容",
    "批准，执行前先备份数据库",
    "批准，第二步改成串行",
    "approved, but fix the typo first",
  ];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "revise", JSON.stringify(p));
  }
});

test("pure approvals release execution", () => {
  const cases = [
    "批准",
    "开始执行，按这个计划做",
    "可以执行",
    "approved, go ahead",
    "就这样，可以",
    "lgtm",
    "好的，就这么办",
    "批准，继续",
  ];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "approve", JSON.stringify(p));
  }
});

test("先执行吧 is a starter, not a scope limit", () => {
  // v0.15 SCOPE_LIMIT_RE false positive: 先…执行 narrowed the plan.
  // The strip grammar correctly reduces this to filler (approve).
  assert.equal(classifyPlanResponse("批准，先执行吧"), "approve");
  assert.equal(classifyPlanResponse("先执行吧"), "approve");
});

test("questions about the plan are discussion", () => {
  const cases = [
    "为什么这么设计？",
    "第二步的回滚方案是什么",
    "可以执行吗",
    "why is step 2 like that?",
  ];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "discuss", JSON.stringify(p));
  }
});

test("cancellation", () => {
  const cases = [
    "先别做了",
    "取消这个计划",
    "不批准",
    "不通过",
    "不要执行",
    "reject the plan",
  ];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "cancel", JSON.stringify(p));
  }
});

test("continuation-only responses stay unknown (ambiguous)", () => {
  const cases = ["继续", "帮我看看这个", "嗯", "稍等"];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "unknown", JSON.stringify(p));
  }
});

test("latin strip respects word boundaries (google)", () => {
  // "go" must not eat into "google".
  assert.equal(classifyPlanResponse("google 一下这个报错"), "unknown");
});

test("empty input", () => {
  assert.equal(classifyPlanResponse(""), "unknown");
  assert.equal(classifyPlanResponse(null), "unknown");
});
