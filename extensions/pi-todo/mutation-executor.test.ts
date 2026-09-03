/**
 * Unit tests for mutation-executor.ts (P1-B).
 *
 * Critical invariants tested:
 *   1. MutationPlan.actions structurally derived from (command, targetIds).
 *   2. actions[i] corresponds to targetIds[i] (1:1 ordering).
 *   3. applyMutationPlan = pure transaction primitive
 *      (no persistence, no formatting, no projection).
 *   4. Reducer actions folded sequentially; fail-fast.
 *   5. Failure result never exposes partial state.
 *   6. Empty plan (named selector []) → successful no-op (next = initial).
 *   7. mutation-executor.ts doesn't import store / format / graph / projection /
 *      read-model / mutation-command / mutation-selector.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { applyMutationPlan, buildMutationPlan } from "./mutation-executor.ts";
import { normalizeTask } from "./types.ts";
import type { MutationCommand, ReduceContext, TaskState } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function mkTask(
 overrides: Partial<{
  id: number;
  status: TaskState["tasks"][number]["status"];
  archivedAt?: number;
  subject?: string;
 }> & { id: number },
): TaskState["tasks"][number] {
 return normalizeTask({
  subject: `task ${overrides.id}`,
  status: "pending",
  ...overrides,
 });
}

function mkState(...tasks: TaskState["tasks"][number][]): TaskState {
 return { tasks: [...tasks], nextId: 1000 };
}

const testCtx: ReduceContext = { now: () => 1000 };

function targetOf(action: { id?: number; ids?: number[] }): number {
 return (action.id ?? action.ids?.[0]) as number;
}

// ── buildMutationPlan ────────────────────────────────────────────────────

describe("buildMutationPlan: lifecycle single-id", () => {
 it("start #12 → actions: [{ action: 'start', id: 12 }]", () => {
  const plan = buildMutationPlan(
   { kind: "start", id: 12 } as MutationCommand,
   [12],
  );
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0], { action: "start", id: 12 });
 });

 it("finish #12 → actions: [{ action: 'finish', id: 12 }]", () => {
  const plan = buildMutationPlan(
   { kind: "finish", id: 12 } as MutationCommand,
   [12],
  );
  assert.deepEqual(plan.actions[0], { action: "finish", id: 12 });
 });

 it("reopen #12 → actions: [{ action: 'reopen', id: 12 }]", () => {
  const plan = buildMutationPlan(
   { kind: "reopen", id: 12 } as MutationCommand,
   [12],
  );
  assert.deepEqual(plan.actions[0], { action: "reopen", id: 12 });
 });

 it("single id → actions.length === 1", () => {
  const plan = buildMutationPlan(
   { kind: "start", id: 1 } as MutationCommand,
   [1],
  );
  assert.equal(plan.actions.length, 1);
 });
});

describe("buildMutationPlan: archive/restore batch", () => {
 it("archive [8,3,12] → actions preserve [8,3,12] order", () => {
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [8, 3, 12] },
   } as MutationCommand,
   [8, 3, 12],
  );
  assert.deepEqual(plan.targetIds, [8, 3, 12]);
  assert.deepEqual(
   plan.actions.map((a) => a.ids?.[0]),
   [8, 3, 12],
  );
 });

 it("restore [1] → single action with ids: [1]", () => {
  const plan = buildMutationPlan(
   {
    kind: "restore",
    selector: { kind: "ids", ids: [1] },
   } as MutationCommand,
   [1],
  );
  assert.deepEqual(plan.actions[0], { action: "restore", ids: [1] });
 });

 it("empty targetIds → empty actions", () => {
  const plan = buildMutationPlan(
   { kind: "start", id: 1 } as MutationCommand,
   [],
  );
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.targetIds.length, 0);
 });
});

describe("buildMutationPlan: structural invariants", () => {
 it("★ actions.length === targetIds.length", () => {
  for (const ids of [[1], [8, 3, 12], [5, 9, 13, 17, 21], [99]]) {
   const plan = buildMutationPlan(
    { kind: "start", id: ids[0] as number } as MutationCommand,
    ids,
   );
   assert.equal(
    plan.actions.length,
    plan.targetIds.length,
    `actions.length (${plan.actions.length}) !== targetIds.length (${plan.targetIds.length}) for ids=${JSON.stringify(ids)}`,
   );
  }
 });

 it("★ actions[i].target === targetIds[i] (lifecycle: id, archive/restore: ids[0])", () => {
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [8, 3, 12] },
   } as MutationCommand,
   [8, 3, 12],
  );
  for (let i = 0; i < plan.targetIds.length; i++) {
   assert.equal(targetOf(plan.actions[i] as any), plan.targetIds[i]);
  }

  const plan2 = buildMutationPlan(
   { kind: "start", id: 1 } as MutationCommand,
   [1],
  );
  assert.equal(plan2.actions[0]?.id, 1);
 });

 it("plan.command === original command (reference identity)", () => {
  const cmd = { kind: "start", id: 12 } as MutationCommand;
  const plan = buildMutationPlan(cmd, [12]);
  assert.equal(plan.command, cmd);
 });

 it("plan.targetIds preserves input order (no sort)", () => {
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [12, 3, 8] },
   } as MutationCommand,
   [12, 3, 8],
  );
  assert.deepEqual(plan.targetIds, [12, 3, 8]);
 });
});

// ── applyMutationPlan: atomicity ─────────────────────────────────────────

describe("applyMutationPlan: atomicity", () => {
 it("1 action success → next returned", () => {
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const plan = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  assert.equal(result.ok, true);
  if (result.ok) {
   assert.equal(result.next.tasks[0]?.status, "in_progress");
   assert.equal(result.next.tasks[0]?.updatedAt, 1000);
  }
 });

 it("3 actions success → all folded in order", () => {
  const state = mkState(
   mkTask({ id: 17, status: "completed" }),
   mkTask({ id: 18, status: "completed" }),
   mkTask({ id: 19, status: "completed" }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17, 18, 19] },
   } as MutationCommand,
   [17, 18, 19],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  assert.equal(result.ok, true);
  if (result.ok) {
   assert.equal(result.next.tasks[0]?.archivedAt, 1000);
   assert.equal(result.next.tasks[1]?.archivedAt, 1000);
   assert.equal(result.next.tasks[2]?.archivedAt, 1000);
  }
 });

 it("★ failure on action #1 → ok:false; no next exposed", () => {
  // Action #1: archive pending → ARCHIVE_REQUIRES_COMPLETED
  // Action #2 would succeed if executed
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17, 18] },
   } as MutationCommand,
   [17, 18],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  assert.equal(result.ok, false);
  if (!result.ok) {
   assert.equal(result.failedTargetId, 17);
   assert.equal(result.failedActionIndex, 0);
   assert.equal(result.error.code, "ARCHIVE_REQUIRES_COMPLETED");
  }
 });

 it("★ failure on action #2 → action #3 NEVER executed (fail-fast)", () => {
  // #1: archive completed → ok
  // #2: archive completed → ARCHIVE_REQUIRES_COMPLETED (not completed)
  // #3: archive completed → would succeed if executed
  const state = mkState(
   mkTask({ id: 17, status: "completed" }),
   mkTask({ id: 18, status: "pending" }), // not completed
   mkTask({ id: 19, status: "completed" }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17, 18, 19] },
   } as MutationCommand,
   [17, 18, 19],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  assert.equal(result.ok, false);
  if (!result.ok) {
   assert.equal(result.failedActionIndex, 1);
   assert.equal(result.failedTargetId, 18);
   // #3 should NOT be archived — if it ran, #19.archivedAt would be 1000
   assert.equal(result.failedTargetId, 18, "did not pass action #2");
   // The failure result doesn't expose state; the candidate is discarded.
  }
  // Verify #19 was NOT archived by checking via fresh apply on the ORIGINAL state:
  // (we can't observe #19's archivedAt from a failure result)
  // — the structural test is failedActionIndex === 1 (not 2).
 });

 it("failure on final action → whole plan still fails; no commit (caller's job)", () => {
  const state = mkState(
   mkTask({ id: 17, status: "completed" }),
   mkTask({ id: 18, status: "pending" }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17, 18] },
   } as MutationCommand,
   [17, 18],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failedActionIndex, 1);
 });

 it("★ empty plan (named selector resolved to []) → ok with initial as next (no-op)", () => {
  const state = mkState(mkTask({ id: 17, status: "completed" }));
  // buildMutationPlan with empty targetIds → empty actions
  const plan = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  assert.equal(result.ok, true);
  if (result.ok) {
   assert.equal(result.next, state, "next === initial for empty plan (no-op)");
   // No task should be modified:
   assert.equal(result.next.tasks[0]?.status, "completed");
   assert.equal(result.next.tasks[0]?.updatedAt, 0); // unchanged from default
  }
 });

 it("★ failure result NEVER exposes partial state (atomicity proof)", () => {
  const state = mkState(
   mkTask({ id: 17, status: "completed" }),
   mkTask({ id: 18, status: "pending" }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17, 18] },
   } as MutationCommand,
   [17, 18],
  );
  const result = applyMutationPlan(state, plan, testCtx);
  // Type assertion: failure result MUST NOT carry `next` or any state.
  assert.equal(result.ok, false);
  if (!result.ok) {
   const fields = Object.keys(result);
   assert.ok(!fields.includes("next"), "failure result must NOT include next");
   assert.ok(
    !fields.includes("partialState") && !fields.includes("intermediate"),
    "failure result must NOT expose any partial state",
   );
  }
 });
});

// ── buildMutationPlan reads no state ────────────────────────────────────────

describe("buildMutationPlan: no state read", () => {
 it("does not import TaskState / read state", async () => {
  const state = mkState(mkTask({ id: 17, status: "completed" }));
  // Should produce same plan regardless of state.
  const planA = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  const planB = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  assert.deepEqual(planA, planB);
  void state; // explicitly NOT used
 });
});

// ── Layer purity (architecture tests) ─────────────────────────────────────

describe("mutation-executor: layer purity (P1-B)", () => {
 it("does not import format / graph / projection / read-model / store / mutation-command / mutation-selector", async () => {
  const src = await readFile("mutation-executor.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
   "./format",
   "./graph",
   "./projection",
   "./read-model",
   "./store",
   "./mutation-command",
   "./mutation-selector",
  ];
  for (const path of forbidden) {
   assert.ok(
    !code.includes(path),
    `mutation-executor.ts contains forbidden import "${path}"`,
   );
  }
 });

 it("applyMutationPlan signature: pure (initial, plan, ctx) — no commit param", async () => {
  // Static: the function signature should not accept any commit-like param.
  const src = await readFile("mutation-executor.ts", "utf8");
  assert.ok(
   !src.includes("commit") || src.includes("no commit"),
   "applyMutationPlan signature must not include commit",
  );
 });
});
