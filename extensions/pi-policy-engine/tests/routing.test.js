// router.js + preview end-to-end tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTask } from "../src/core/classifier.js";
import { chooseWorkflow, modelPolicyId } from "../src/core/router.js";
import { preview } from "../extensions/policy-engine/state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routing = JSON.parse(
  readFileSync(join(root, "config", "routing.json"), "utf8"),
);

test("modelPolicyId mapping", () => {
  assert.equal(
    modelPolicyId({ provider: "minimax-cn", id: "MiniMax-M3" }),
    "model.minimax-m3",
  );
  assert.equal(
    modelPolicyId({ provider: "deepseek", id: "deepseek-v4" }),
    "model.deepseek",
  );
  assert.equal(modelPolicyId({ provider: "foo", id: "bar" }), null);
});

test("workflow routing matrix", () => {
  const quick = classifyTask(
    "帮我只改 README 里的一处 Tab 补全描述",
    routing,
    [],
  );
  assert.equal(chooseWorkflow(quick, "auto"), "quick");

  const debug = classifyTask(
    "这个接口最近偶尔返回旧数据，帮我排查 bug 并修复",
    routing,
    [],
  );
  assert.equal(chooseWorkflow(debug, "auto"), "standard");

  const strict = classifyTask(
    "设计 PostgreSQL 数据库迁移方案，线上不能停机，需要回滚",
    routing,
    [],
  );
  assert.equal(chooseWorkflow(strict, "auto"), "strict");

  const k8s = classifyTask(
    "k8s deployment 的 hostPath 挂载需要调整，生产环境不能停机",
    routing,
    [],
  );
  assert.equal(chooseWorkflow(k8s, "auto"), "strict");

  // read-only intent downgrades strict rigor to standard
  const readonly = classifyTask(
    "只分析这个数据库迁移方案，不要修改任何文件",
    routing,
    [],
  );
  assert.equal(chooseWorkflow(readonly, "auto"), "standard");
});

test("preview() end-to-end: strict PG migration", async () => {
  const result = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "修一个 PG migration bug，线上回滚",
    model: { provider: "minimax-cn", id: "MiniMax-M3" },
  });
  assert.ok(result.decision);
  assert.equal(result.decision.workflow, "strict");
  assert.ok(result.decision.domains.includes("database"));
  assert.ok(result.wouldRequireApproval);
  assert.ok(result.policies.some((p) => p.id === "core.evidence-priority"));
  assert.ok(result.policies.some((p) => p.id === "model.minimax-m3"));
  assert.ok(result.stats.builtInBytes > 0);
  assert.ok(result.stats.budget > 0);
  assert.ok(
    result.stats.budgetUsedPct >= 0 && result.stats.budgetUsedPct <= 100,
  );
});

test("preview() includes resolved config (history append contract)", async () => {
  const result = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "preview config field regression test",
    model: null,
  });
  assert.ok(result.config && typeof result.config === "object");
  assert.equal(typeof result.config.historyFile, "string");
});

test("preview() is a pure read — no shared-state mutation", async () => {
  const before = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "low-risk readme typo",
    model: null,
  });
  const after = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "high-risk 生产 PG schema 迁移",
    model: null,
  });
  assert.equal(before.decision.workflow, "quick");
  assert.equal(after.decision.workflow, "strict");
});
