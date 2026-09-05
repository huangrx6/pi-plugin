// router.js + preview end-to-end tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTask } from "../src/core/classifier.js";
import {
  chooseRigor,
  chooseFlow,
  modelPolicyId,
  loadModelRules,
} from "../src/core/router.js";
import { preview } from "../extensions/policy-engine/state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routing = JSON.parse(
  readFileSync(join(root, "config", "routing.json"), "utf8"),
);

test("modelPolicyId maps via config/models.json rules (v0.22 structured)", () => {
  const rules = loadModelRules(root);
  assert.ok(Array.isArray(rules) && rules.length >= 2);
  assert.equal(
    modelPolicyId({ provider: "minimax-cn", id: "MiniMax-M3" }, rules),
    "model.minimax-m3",
  );
  // substring era bugs: M30 ate the M3 policy; notdeepseek matched deepseek.
  assert.equal(
    modelPolicyId({ provider: "minimax-cn", id: "MiniMax-M30" }, rules),
    null,
  );
  assert.equal(
    modelPolicyId({ provider: "notdeepseek", id: "x" }, rules),
    null,
  );
  // provider-scoped rule covers every model of that provider.
  assert.equal(
    modelPolicyId({ provider: "deepseek", id: "deepseeker" }, rules),
    "model.deepseek",
  );
});

test("flow derives from task type, independent of rigor", () => {
  const debugging = {
    taskType: "debugging",
    risk: "low",
    executionIntent: "mutate",
  };
  assert.equal(chooseFlow(debugging), "debug-first");
  // debug-first pairs with ANY rigor
  assert.equal(chooseRigor(debugging, "auto"), "quick");
  assert.equal(chooseRigor({ ...debugging, risk: "high" }, "auto"), "strict");
  assert.equal(chooseFlow({ taskType: "coding", risk: "low" }), null);
});

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
  assert.equal(chooseRigor(quick, "auto"), "quick");

  const debug = classifyTask(
    "这个接口最近偶尔返回旧数据，帮我排查 bug 并修复",
    routing,
    [],
  );
  assert.equal(chooseRigor(debug, "auto"), "standard");

  // v0.21: a pure design deliverable is read-only → standard; the strict
  // case needs an implementation marker or an explicit approval gate.
  const design = classifyTask(
    "设计 PostgreSQL 数据库迁移方案，线上不能停机，需要回滚",
    routing,
    [],
  );
  assert.equal(design.executionIntent, "read-only");
  assert.equal(chooseRigor(design, "auto"), "standard");

  const strict = classifyTask(
    "设计生产环境 PostgreSQL 数据库迁移方案并实施，不能停机，需要回滚",
    routing,
    [],
  );
  assert.equal(chooseRigor(strict, "auto"), "strict");

  const gated = classifyTask("先别改，给我方案，确认后再执行", routing, []);
  assert.equal(chooseRigor(gated, "auto"), "strict");

  // v0.22 P0: the CURRENT-prompt explicit gate outranks a pinned runtime
  // mode — /policy standard must not silence 确认后再执行. Only /policy off
  // wins; a per-prompt negation lifts the gate so the pin applies again.
  assert.equal(chooseRigor(gated, "quick"), "strict");
  assert.equal(chooseRigor(gated, "standard"), "strict");
  assert.equal(chooseRigor(gated, "off"), "off");
  const lifted = classifyTask("不需要确认后再执行，直接修改代码", routing, []);
  assert.equal(lifted.approvalRequired, null);
  assert.equal(chooseRigor(lifted, "quick"), "quick");

  const k8s = classifyTask(
    "k8s deployment 的 hostPath 挂载需要调整，生产环境不能停机",
    routing,
    [],
  );
  assert.equal(chooseRigor(k8s, "auto"), "strict");

  // read-only intent downgrades strict rigor to standard
  const readonly = classifyTask(
    "只分析这个数据库迁移方案，不要修改任何文件",
    routing,
    [],
  );
  assert.equal(chooseRigor(readonly, "auto"), "standard");

  assert.equal(
    chooseRigor(
      {
        taskType: "coding",
        executionIntent: "unclear",
        risk: "low",
        coverage: "focused",
      },
      "auto",
    ),
    "standard",
  );
  assert.equal(
    chooseRigor(
      {
        taskType: "coding",
        executionIntent: "mutate",
        risk: "low",
        coverage: "comprehensive",
      },
      "auto",
    ),
    "standard",
  );
});

test("an underspecified conversational result keeps a clarification policy", () => {
  assert.equal(
    chooseRigor(
      {
        taskType: "conversation",
        executionIntent: "unclear",
        risk: "low",
        coverage: "focused",
      },
      "auto",
    ),
    "standard",
  );
  assert.equal(
    chooseRigor(
      {
        taskType: "conversation",
        executionIntent: "read-only",
        risk: "low",
        coverage: "focused",
      },
      "auto",
    ),
    "off",
  );
});

test("preview() end-to-end: strict PG migration", async () => {
  const result = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "修一个 PG migration bug，线上回滚",
    model: { provider: "minimax-cn", id: "MiniMax-M3" },
  });
  assert.ok(result.decision);
  assert.equal(result.decision.rigor, "strict");
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
  assert.equal(before.decision.rigor, "standard");
  assert.equal(after.decision.rigor, "strict");
});
