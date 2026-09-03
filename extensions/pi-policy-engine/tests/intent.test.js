// intent.js unit tests: execution intent + intent frame extraction.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractExecutionIntent,
  extractExecutionMeta,
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

test("v0.17 advisory modality: asking HOW to change is read-only", () => {
  const cases = [
    ["告诉我如何修复这个问题，不要修改代码", "read-only"],
    ["不要改代码，只告诉我应该怎么修改", "read-only"],
    ["分析一下怎么修改这个接口", "read-only"],
    ["不要部署，只给我部署步骤", "read-only"],
    ["给我修复方案", "read-only"],
    ["how to fix this issue", "read-only"],
    ["show me how to deploy", "read-only"],
    ["what should I change", "read-only"],
  ];
  for (const [prompt, want] of cases) {
    assert.equal(
      extractExecutionIntent(prompt),
      want,
      `advisory(${JSON.stringify(prompt.slice(0, 24))})`,
    );
  }
});

test("v0.17 advisory never swallows direct commands", () => {
  const cases = [
    ["帮我修复这个 bug", "mutate"],
    ["帮我修改这段代码", "mutate"],
    ["部署一下到测试环境", "mutate"],
    ["直接修改代码", "mutate"],
    ["change the config", "mutate"],
    ["告诉我如何修复，然后你直接修改", "mutate"], // later direct clause wins
    [
      "设计生产环境 PostgreSQL 数据库迁移方案并实施，不能停机，需要回滚",
      "mutate",
    ],
    ["写一份修复方案文档", "mutate"], // 写 live beats the 方案 noun
  ];
  for (const [prompt, want] of cases) {
    assert.equal(
      extractExecutionIntent(prompt),
      want,
      `direct(${JSON.stringify(prompt.slice(0, 24))})`,
    );
  }
});

test("v0.21 design/plan deliverables are read-only; 并实施 flips them back", () => {
  // v0.17 called this "dead" (unclear); the user's final ruling: the plan
  // IS the product → read-only. Rigor lands standard via the read-only
  // downgrade, risk stays high, task stays architecture.
  assert.equal(
    extractExecutionIntent(
      "设计 PostgreSQL 数据库迁移方案，线上不能停机，需要回滚",
    ),
    "read-only",
  );
  // An implementation marker in the same clause keeps it a mutation task.
  assert.equal(
    extractExecutionIntent("设计生产环境 PostgreSQL 数据库迁移方案并实施"),
    "mutate",
  );
});

test("v0.21 explicit approval gate + scoped negation meta", () => {
  assert.deepEqual(extractExecutionMeta("先别改，给我方案，确认后再执行"), {
    executionIntent: "mutate",
    executionTiming: "deferred",
    approvalRequired: "explicit",
  });
  assert.equal(
    extractExecutionMeta("修复这个 bug，但不要改数据库").approvalRequired,
    null,
  );
});

test("v0.24 ask-me vocabulary lifts an explicit gate", () => {
  // The demand half still creates the gate when nothing lifts it…
  assert.equal(
    extractExecutionMeta("给方案，确认后再执行").approvalRequired,
    "explicit",
  );
  // …but the same message plus an ask-me release lifts it to null —
  // the live v0.24 failure mode (询问/意见 were invisible to v0.23).
  assert.equal(
    extractExecutionMeta("给方案，确认后再执行，不用征求我的意见了")
      .approvalRequired,
    null,
  );
  assert.equal(
    extractExecutionMeta("先给方案，确认后再执行，不用询问我")
      .approvalRequired,
    null,
  );
});

test("research frame includes 分析", () => {
  const frame = extractIntentFrame("分析一下这个方案");
  assert.equal(frame.action, "research");
});
