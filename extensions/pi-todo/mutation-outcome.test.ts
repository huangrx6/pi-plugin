/**
 * Unit tests for mutation-outcome.ts (P1-C materialization).
 *
 * Critical invariants tested:
 *   1. buildMutationOutcome is the only consumer of prev/next TaskState.
 *   2. Targets derived from classifyTask — `reopen` can produce READY or
 *      BLOCKED depending on actual deps, NOT hardcoded BLOCKED.
 *   3. diff from diffActiveView (canonical B1 primitive).
 *   4. depsMap for BLOCKED consequences only.
 *   5. NO prev / next fields in MutationOutcome (state never crosses).
 *   6. NO changedTargetIds field.
 *   7. Layer purity: only imports types + projection + read-model +
 *      mutation-executor. NOT graph, NOT format, NOT store, NOT command,
 *      NOT selector, NOT format itself.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { buildMutationOutcome } from "./mutation-outcome.ts";
import { buildMutationPlan } from "./mutation-executor.ts";
import { normalizeTask } from "./types.ts";
import type { MutationCommand, TaskState } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function mkTask(
 overrides: Partial<{
  id: number;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy?: number[];
  archivedAt?: number;
  subject?: string;
  createdAt?: number;
  updatedAt?: number;
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

// ── buildMutationOutcome: structure ────────────────────────────────────────

describe("buildMutationOutcome: structure", () => {
 it("returns commandKind from plan", () => {
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const plan = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(state, state, plan);
  assert.equal(out.commandKind, "start");
 });

 it("returns targetIds from plan (frozen, no re-derivation)", () => {
  const state = mkState(
   mkTask({ id: 1, status: "completed" }),
   mkTask({ id: 2, status: "completed" }),
   mkTask({ id: 3, status: "completed" }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [1, 2, 3] },
   } as MutationCommand,
   [1, 2, 3],
  );
  const out = buildMutationOutcome(state, state, plan);
  assert.deepEqual([...out.targetIds], [1, 2, 3]);
 });

 it("★ NO prev / next fields in MutationOutcome (state never crosses boundary)", () => {
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const plan = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(state, state, plan);
  const fields = Object.keys(out);
  assert.ok(!fields.includes("prev"), "MutationOutcome must NOT have 'prev'");
  assert.ok(!fields.includes("next"), "MutationOutcome must NOT have 'next'");
  assert.ok(
   !fields.includes("changedTargetIds"),
   "MutationOutcome must NOT have 'changedTargetIds'",
  );
 });

 it("targets array has one entry per plan.targetIds, in order", () => {
  const state = mkState(
   mkTask({ id: 8, status: "completed" }),
   mkTask({ id: 3, status: "completed" }),
   mkTask({ id: 12, status: "completed" }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [8, 3, 12] },
   } as MutationCommand,
   [8, 3, 12],
  );
  const out = buildMutationOutcome(state, state, plan);
  assert.equal(out.targets.length, 3);
  assert.deepEqual(
   out.targets.map((t) => t.id),
   [8, 3, 12],
  );
 });
});

// ── buildMutationOutcome: target presentation ────────────────────────────

describe("buildMutationOutcome: target presentation", () => {
 it("start #17 (pending) → role='running' (after start it's in_progress)", () => {
  const prev = mkState(mkTask({ id: 17, status: "pending" }));
  const next = mkState(mkTask({ id: 17, status: "in_progress", updatedAt: 1 }));
  const plan = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.targets[0]?.role, "running");
  assert.equal(out.targets[0]?.status, "in_progress");
 });

 it("finish #17 (in_progress) → role='completed' (not in active view)", () => {
  const prev = mkState(mkTask({ id: 17, status: "in_progress" }));
  const next = mkState(mkTask({ id: 17, status: "completed" }));
  const plan = buildMutationPlan(
   { kind: "finish", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.targets[0]?.role, "completed");
  assert.equal(out.targets[0]?.status, "completed");
 });

 it("★ reopen #17 with NO deps → role='ready' (NOT hardcoded BLOCKED)", () => {
  // After reopen, #17 is pending with no deps → ready (not blocked)
  const prev = mkState(mkTask({ id: 17, status: "completed" }));
  const next = mkState(mkTask({ id: 17, status: "pending" }));
  const plan = buildMutationPlan(
   { kind: "reopen", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.targets[0]?.role, "ready");
  assert.equal(out.targets[0]?.status, "pending");
 });

 it("★ reopen #17 WITH unsatisfied dep → role='blocked' (canonical)", () => {
  // After reopen, #17 is pending with dep on #18 (still pending) → blocked
  const prev = mkState(
   mkTask({ id: 17, status: "completed", blockedBy: [18] }),
   mkTask({ id: 18, status: "pending" }),
  );
  const next = mkState(
   mkTask({ id: 17, status: "pending", blockedBy: [18] }),
   mkTask({ id: 18, status: "pending" }),
  );
  const plan = buildMutationPlan(
   { kind: "reopen", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.targets[0]?.role, "blocked");
 });

 it("archive #17 (completed) → role='archived'", () => {
  const prev = mkState(mkTask({ id: 17, status: "completed" }));
  const next = mkState(
   mkTask({ id: 17, status: "completed", archivedAt: 100 }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17] },
   } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.targets[0]?.role, "archived");
  assert.equal(out.targets[0]?.status, "completed");
 });

 it("restore #17 (archived) → role=classification from status", () => {
  // After restore, archivedAt=undefined. If status=completed → role=completed
  const prev = mkState(
   mkTask({ id: 17, status: "completed", archivedAt: 100 }),
  );
  const next = mkState(mkTask({ id: 17, status: "completed" }));
  const plan = buildMutationPlan(
   {
    kind: "restore",
    selector: { kind: "ids", ids: [17] },
   } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.targets[0]?.role, "completed");
 });
});

// ── buildMutationOutcome: depsMap ──────────────────────────────────────────

describe("buildMutationOutcome: depsMap", () => {
 it("depsMap populated only for diff.becameBlocked", () => {
  // finish #1 → #2 (blocked on #1) becomes ready, not blocked
  // finish #1 → #3 (blocked on #1 and #4) becomes blocked (still needs #4)
  const prev = mkState(
   mkTask({ id: 1, status: "in_progress" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
   mkTask({ id: 3, status: "pending", blockedBy: [1, 4] }),
   mkTask({ id: 4, status: "pending" }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "completed", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
   mkTask({ id: 3, status: "pending", blockedBy: [1, 4] }),
   mkTask({ id: 4, status: "pending" }),
  );
  const plan = buildMutationPlan(
   { kind: "finish", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.diff.becameReady.length, 1); // #2
  assert.equal(out.diff.becameReady[0]?.id, 2);
  // #3 was already blocked and still is — not in becameBlocked (no flip)
  assert.equal(out.diff.becameBlocked.length, 0);
  // depsMap should be empty (no new blocked)
  assert.equal(out.depsMap.size, 0);
 });

 it("depsMap contains deps for newly-blocked tasks", () => {
  // reopen #1 (was completed) → #2 (was ready, blocked on #1) becomes blocked
  const prev = mkState(
   mkTask({ id: 1, status: "completed" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "pending", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const plan = buildMutationPlan(
   { kind: "reopen", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  assert.equal(out.diff.becameBlocked.length, 1);
  assert.equal(out.diff.becameBlocked[0]?.id, 2);
  // #2 has depsMap entry for #1 (waiting)
  const deps2 = out.depsMap.get(2);
  assert.ok(deps2, "depsMap should have entry for newly-blocked #2");
  assert.equal(deps2?.[0]?.id, 1);
  assert.equal(deps2?.[0]?.kind, "waiting");
 });
});

// ── buildMutationOutcome: diff passthrough ─────────────────────────────

describe("buildMutationOutcome: diff is from diffActiveView", () => {
 it("diff is exactly diffActiveView(prev, next)", () => {
  // #1 (in_progress) → completed: leaves active.
  // #2 (blocked on #1): before, deps unsatisfied (in_progress ≠ completed);
  // after, deps satisfied (completed). Membership flip: blocked → ready.
  const prev = mkState(
   mkTask({ id: 1, status: "in_progress" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "completed", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const plan = buildMutationPlan(
   { kind: "finish", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  // #2 becomes ready (was blocked on in_progress, now blocked on completed).
  assert.equal(out.diff.becameReady.length, 1);
  assert.equal(out.diff.becameReady[0]?.id, 2);
  assert.equal(out.diff.becameBlocked.length, 0);
 });

 it("finish that flips a dependent to ready surfaces in becameReady", () => {
  const prev = mkState(
   mkTask({ id: 1, status: "in_progress" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "completed", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const plan = buildMutationPlan(
   { kind: "finish", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  // Hmm, #2 was blocked before AND after. Did it ever become ready?
  // #1 was in_progress → completed (no longer in active). #2 was blocked,
  // still blocked (still depends on #1, which is now completed → #2 becomes
  // ready). So #2 IS in becameReady.
  assert.equal(out.diff.becameReady.length, 1);
  assert.equal(out.diff.becameReady[0]?.id, 2);
 });
});

// ── Layer purity ────────────────────────────────────────────────────────

describe("mutation-outcome: layer purity (P1-C)", () => {
 it("imports only types + projection + read-model + mutation-executor (NOT graph/format/store/etc.)", async () => {
  const src = await readFile("mutation-outcome.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
   "./graph",
   "./format",
   "./store",
   "./mutation-command",
   "./mutation-selector",
   "./mutation-format",
  ];
  for (const p of forbidden) {
   assert.ok(
    !code.includes(p),
    `mutation-outcome.ts contains forbidden import "${p}"`,
   );
  }
 });
});
