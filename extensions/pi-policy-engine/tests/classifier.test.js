// classifier.js unit tests: task routing, domains, risk, confidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTask } from "../src/core/classifier.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routing = JSON.parse(
  readFileSync(join(root, "config", "routing.json"), "utf8"),
);

function c(prompt) {
  return classifyTask(prompt, routing, []);
}

test("documentation quick task", () => {
  const x = c("帮我只改 README 里的一处 Tab 补全描述");
  assert.equal(x.taskType, "documentation");
  assert.equal(x.risk, "low");
});

test("debugging task with strong signals", () => {
  const x = c("这个接口最近偶尔返回旧数据，帮我排查 bug 并修复");
  assert.equal(x.taskType, "debugging");
});

test("high-risk PG migration is architecture/strict", () => {
  const x = c("设计 PostgreSQL 数据库迁移方案，线上不能停机，需要回滚");
  assert.equal(x.taskType, "architecture");
  assert.equal(x.risk, "high");
  assert.ok(x.domains.includes("database"));
});

test("k8s production change is high risk", () => {
  const x = c("k8s deployment 的 hostPath 挂载需要调整，生产环境不能停机");
  assert.equal(x.risk, "high");
  assert.ok(x.domains.includes("kubernetes"));
});

test("read-only intent on migration topic", () => {
  const x = c("只分析这个数据库迁移方案，不要修改任何文件");
  assert.equal(x.executionIntent, "read-only");
});

test("v0.16 intent beats mention: README fix routes to documentation", () => {
  // Was architecture/high (背景 mention of 架构/拆分 outweighed the actual
  // request). The imperative frame 帮我…改…文档 must anchor documentation.
  const x = c(
    "README 里记录了之前架构拆分失败的原因，现在帮我把这段文档改准确",
  );
  assert.equal(x.taskType, "documentation");
  assert.equal(x.risk, "low");
  assert.equal(x.executionIntent, "mutate");
  assert.ok(x.reasons.some((r) => r.startsWith("frame:")));
});

test("v0.16 English word forms match their groups", () => {
  assert.equal(c("debugging issue in parser").taskType, "debugging");
  assert.equal(c("errors in parser").taskType, "debugging");
  assert.equal(c("bugs in parser").taskType, "debugging");
  assert.equal(c("reviewing this diff").taskType, "review");
});

test("reproduction steps never matches risk:high via prod", () => {
  const x = c("Please write reproduction steps for this bug");
  assert.equal(x.taskType, "debugging");
  assert.notEqual(x.risk, "high");
});

test("weak domain keywords need co-occurrence", () => {
  // Single weak term (组件) must NOT drag in frontend policy.
  const one = c("帮我看看这个业务组件的实现逻辑");
  assert.ok(!one.domains.includes("frontend"));
  assert.ok(
    one.reasons.some((r) => r.includes("domain:frontend dropped (weak-only")),
  );

  // Two weak terms in the same domain = enough signal.
  const two = c("数据库和索引优化一下");
  assert.ok(two.domains.includes("database"));

  // A single strong term fires immediately.
  const strong = c("postgres 的连接池怎么配");
  assert.ok(strong.domains.includes("database"));
});

test("same-group domain aliases never stack (api + 接口 = 1 weak)", () => {
  const x = c("这个 api 和那个接口怎么调用");
  assert.ok(
    !x.domains.includes("backend"),
    `api/接口 aliases must stay one weak signal: ${x.domains}`,
  );
  assert.ok(x.reasons.some((r) => r.includes("same-group aliases never stack")));
});

test("domain count is capped (default 2), ranked by score", () => {
  const x = c(
    "postgres schema 迁移，k8s deployment 调整，还要加 jwt 鉴权，涉及后端接口和微服务",
  );
  assert.ok(x.domains.length <= 2);
  assert.ok(x.domains.includes("database"));
  assert.ok(x.reasons.some((r) => r.includes("dropped (capped at 2")));
});

test("confidence reflects candidate dispersion", () => {
  // Near-tie across task types → honest low confidence.
  const tie = c("文档 docs markdown 里有个错误要定位，顺便架构拆分一下");
  assert.ok(tie.confidence <= 0.75, `dispersed: ${tie.confidence}`);
  assert.ok(tie.reasons.some((r) => r.startsWith("confidence penalized")));

  // Clear winner → stays high.
  const clear = c("修复这个 bug：接口报错 exception，定位到失败原因");
  assert.equal(clear.taskType, "debugging");
  assert.ok(clear.confidence >= 0.8, `clear winner: ${clear.confidence}`);
  assert.ok(
    !clear.reasons.some((r) => r.startsWith("confidence penalized")),
  );
});

test("coding is the honest default (base 0.5), beaten by one real group", () => {
  const x = c("写个工具处理一下");
  assert.equal(x.taskType, "coding");
});
