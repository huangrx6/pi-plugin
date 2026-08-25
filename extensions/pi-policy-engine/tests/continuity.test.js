// Task Continuity (v0.18): bare follow-ups inherit the previous task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFollowUpPrompt } from "../src/core/intent.js";
import { decide } from "../extensions/policy-engine/state.js";
import { createState } from "../extensions/policy-engine/state.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const lastDecision = {
  taskType: "debugging",
  risk: "medium",
  rigor: "standard",
  profile: "debugging",
  confidence: 0.85,
  executionIntent: "mutate",
  domains: ["database", "backend"],
};

test("isFollowUpPrompt: verified follow-up family", () => {
  const yes = [
    "继续", "继续修", "继续改一下", "接着做", "再看看", "再试试",
    "还是不对", "没修好", "刚才那个", "这个地方呢", "按这个做", "还差一点",
  ];
  const no = [
    "继续，只分析", // carries an instruction
    "还是不对，先看日志再说",
    "继续修改数据库的连接池配置", // real work described
    "帮我修另一个 bug", // new task
    "按这个计划重新设计",
  ];
  for (const p of yes) assert.ok(isFollowUpPrompt(p), JSON.stringify(p));
  for (const p of no) assert.ok(!isFollowUpPrompt(p), JSON.stringify(p));
});

test("decide(): follow-up inherits task + domains, intent/risk recomputed", async () => {
  const state = { ...createState(), lastDecision };
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "继续",
    state,
    model: null,
  });
  assert.equal(decision.taskType, "debugging"); // inherited
  assert.deepEqual(decision.domains, ["database", "backend"]); // inherited
  assert.equal(decision.executionIntent, "mutate"); // fresh=unclear → inherit
  assert.ok(decision.reasons.some((r) => r.startsWith("task-continuity:")));
});

test("decide(): fresh intent on the follow-up wins over inherited", async () => {
  // "继续改" carries a live mutation verb — the user is telling it to change
  // something NOW even in the follow-up.
  const state = {
    ...createState(),
    lastDecision: { ...lastDecision, executionIntent: "read-only" },
  };
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "继续改",
    state,
    model: null,
  });
  assert.equal(decision.executionIntent, "mutate"); // fresh beats inherited
});

test("decide(): risk never drops across continuity", async () => {
  const state = { ...createState(), lastDecision: { ...lastDecision, risk: "high" } };
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "再看看",
    state,
    model: null,
  });
  assert.equal(decision.risk, "high"); // fresh would say medium — no downgrade
});

test("decide(): no-evidence default risk never escalates a follow-up", async () => {
  // A quick low-risk task stays quick on "继续" — the fresh pass's
  // "medium" is the no-evidence default, not a finding (smoke caught this:
  // every follow-up silently became standard).
  const state = {
    ...createState(),
    lastDecision: {
      taskType: "documentation",
      risk: "low",
      rigor: "quick",
      profile: "documentation",
      confidence: 0.85,
      executionIntent: "mutate",
      domains: ["documentation"],
    },
  };
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "继续",
    state,
    model: null,
  });
  assert.equal(decision.taskType, "documentation");
  assert.equal(decision.risk, "low");
  assert.equal(decision.rigor, "quick");
});

test("decide(): no lastDecision → full classification (no inheritance)", async () => {
  const state = createState();
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "继续",
    state,
    model: null,
  });
  assert.equal(decision.taskType, "coding"); // fresh default, no continuity
  assert.ok(!decision.reasons.some((r) => r.startsWith("task-continuity:")));
});

test("decide(): previous rigor off → no continuity", async () => {
  const state = {
    ...createState(),
    lastDecision: { ...lastDecision, rigor: "off" },
  };
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "继续",
    state,
    model: null,
  });
  assert.equal(decision.taskType, "coding");
  assert.ok(!decision.reasons.some((r) => r.startsWith("task-continuity:")));
});

test("decide(): non-follow-up prompt → full classification", async () => {
  const state = { ...createState(), lastDecision };
  const { decision } = await decide({
    packageRoot: root,
    cwd: root,
    prompt: "帮我修复登录页面的另一个问题",
    state,
    model: null,
  });
  assert.ok(decision.taskType !== "debugging" || !decision.reasons.some((r) => r.startsWith("task-continuity:")));
});
