// approval.js unit tests: pure-approval grammar (v0.16 strip-based).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTONOMY_GRANT_RE,
  classifyPlanResponse,
} from "../src/core/approval.js";

// ── v0.24 autonomy grants ────────────────────────────────────────
// Live regression (2026-09-03): the user's go-to-bed message released
// the gate but classifyPlanResponse said REVISE, so the agent kept
// presenting plans for an approval that was already granted.

test("v0.24 live regression: 构思完就执行，不用征求我的意见了 → approve", () => {
  assert.equal(
    classifyPlanResponse(
      "所有的内容你自动进行评估，不用询问我，你自己给出具体的实施方案，因为我要休息了，但是你需要持续完成目标，不希望你停下来，优化好再停下来，先好好地构思构思吧，构思完就执行，不用征求我的意见了",
    ),
    "approve",
  );
  // The minimal tail alone must also release.
  assert.equal(
    classifyPlanResponse("构思完就执行，不用征求我的意见了"),
    "approve",
  );
});

test("autonomy grant vocabulary releases the gate", () => {
  const cases = [
    "不用征求我的意见了",
    "不用询问我，直接执行",
    "不用问我了",
    "不需要我确认，直接做",
    "别问我了，你自己决定",
    "自己拿主意就行，不用请示我",
    "全权处理，不用停下来",
    "don't ask me, just do it",
    "keep going without asking",
  ];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "approve", JSON.stringify(p));
  }
});

test("grant + riding constraint stays released (constraint, not re-lock)", () => {
  const cases = [
    "不用征求我的意见了，但是别动数据库",
    "不用问我了，不要重构，保持 API 兼容",
    "don't ask me, but don't touch the schema",
  ];
  for (const p of cases) {
    assert.equal(classifyPlanResponse(p), "approve", JSON.stringify(p));
  }
});

test("grant then question keeps the release (mid-flight question ≠ retraction)", () => {
  assert.equal(
    classifyPlanResponse("不用征求我的意见了，为什么选这个方案？"),
    "approve",
  );
});

test("AUTONOMY_GRANT_RE stays precise (no false releases)", () => {
  const nonGrants = [
    "别问问题，先查文档", // 别问 without the ask-me object
    "自己写个方案", // 自己 + verb, not a decision grant
    "问一下数据库要不要备份", // asking about, not lifting the gate
  ];
  for (const p of nonGrants) {
    assert.equal(AUTONOMY_GRANT_RE.test(p), false, JSON.stringify(p));
  }
});

test("cancel/correction still revokes a release", () => {
  assert.equal(classifyPlanResponse("不用问我了。等等，先别动"), "cancel");
  // A correction head resets the release entirely, so the remainder is
  // classified exactly as it would be with no grant in front (here:
  // bare substantive replacement → unknown; the lifecycle re-decides).
  assert.equal(
    classifyPlanResponse("不用问我了，不对，改成只改 README"),
    classifyPlanResponse("不对，改成只改 README"),
  );
  assert.notEqual(
    classifyPlanResponse("不用问我了，不对，改成只改 README"),
    "approve",
  );
});

test("conditional-execute alone (no grant) stays conservative revise", () => {
  // "构思完就执行" without an explicit grant is approval flavor +
  // substantive leftover — kept as revise (v0.23 semantics unchanged).
  assert.equal(classifyPlanResponse("构思完就执行"), "revise");
});

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
