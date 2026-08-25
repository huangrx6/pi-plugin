// intent.js unit tests: execution intent + intent frame extraction.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractExecutionIntent,
  extractIntentFrame,
} from "../src/core/intent.js";

test("executionIntent three-way classification", () => {
  const cases = [
    ["只分析，不要修改", "read-only"],
    ["不要只分析，直接修改代码", "mutate"], // negation scoping fixed (v0.14)
    ["帮我修复这个 bug", "mutate"],
    ["先分析问题，然后修改", "mutate"], // later clause wins
    ["帮我看看这个", "unclear"], // ambiguous verbs carry no signal
    ["分析一下这个数据库迁移方案的风险", "read-only"], // 迁移方案=noun topic
    ["不需要改代码，审查一下这次提交", "read-only"],
    ["修复登录超时的问题", "mutate"],
    ["please fix the login timeout bug", "mutate"],
    ["just analyze the logs, dont touch anything", "read-only"],
    ["review this PR", "read-only"],
    ["优化这段代码的性能", "mutate"],
    ["这个接口为什么不工作", "unclear"],
    ["排查 PostgreSQL API 为什么偶尔返回旧数据", "read-only"],
    ["继续", "unclear"],
    ["帮我做数据库迁移", "mutate"],
    ["写一个迁移方案文档", "mutate"],
    ["看看 README 里写了什么配置说明", "unclear"], // 写了=past narration
    ["分析下文档里描述的架构", "read-only"],
    ["批准，但是不要改数据库", "unclear"], // plan responses via approval.js
  ];
  for (const [prompt, want] of cases) {
    assert.equal(
      extractExecutionIntent(prompt),
      want,
      `executionIntent(${JSON.stringify(prompt.slice(0, 30))})`,
    );
  }
});

test("v0.16 English and spaced negation is recognized", () => {
  const cases = [
    ["don't fix it, just analyze", "read-only"],
    ["do not fix it, just analyze", "read-only"],
    ["dont fix it, just analyze", "read-only"],
    ["不要 修改，只分析", "read-only"],
    ["cannot delete the table, just explain it", "read-only"],
    ["should not touch the schema, only review it", "read-only"],
    ["will not update the config, analyze first", "read-only"],
  ];
  for (const [prompt, want] of cases) {
    assert.equal(
      extractExecutionIntent(prompt),
      want,
      `negation(${JSON.stringify(prompt)})`,
    );
  }
});

test("bare negation without a read-only verb stays unclear (no release)", () => {
  // No approval, no analysis request — nothing to act on.
  assert.equal(extractExecutionIntent("dont fix it"), "unclear");
  assert.equal(extractExecutionIntent("do not deploy for now"), "unclear");
});

test("intent frame scans ALL clauses and prefers the imperative one", () => {
  // Background first, request last — the frame lives in the last clause.
  const frame = extractIntentFrame(
    "README 里记录了之前架构拆分失败的原因，现在帮我把这段文档改准确",
  );
  assert.ok(frame.frameFound);
  assert.equal(frame.action, "modify");
  assert.ok(frame.frameClause.includes("改"));
  assert.ok(!frame.frameClause.includes("架构拆分"));

  // Imperative-marked clause beats a bare action clause earlier on.
  const pick = extractIntentFrame("改一下格式，另外请更新文档里的链接");
  assert.ok(pick.frameFound);
  assert.ok(pick.frameClause.includes("请更新"));

  // No frame in pure background narration.
  const none = extractIntentFrame("这个 bug 很奇怪");
  assert.equal(none.frameFound, false);
  assert.equal(none.action, null);
});

test("negated and topic-mention verbs never form a frame", () => {
  const negated = extractIntentFrame("不要修改数据库");
  assert.equal(negated.frameFound, false);

  const mention = extractIntentFrame("README 里写了什么配置说明");
  assert.equal(mention.frameFound, false);
});

test("research frame includes 分析", () => {
  const frame = extractIntentFrame("分析一下这个方案");
  assert.equal(frame.action, "research");
});
