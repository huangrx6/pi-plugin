/**
 * Unit tests for graph-query.ts (P2-A materialization).
 *
 * Critical invariants tested (P2-A LOCK):
 *   1. queryNextTasks structurally derived from projectActiveView.ready.
 *   2. Observable precedence: deleted → archived → completed → active.
 *   3. pending + all deps completed = READY (never BLOCKED + empty).
 *   4. blocked.blocking = buildDependencyPresentation(state, id).
 *   5. queryUnlocksTask uses affectedByCompletion.newlySatisfied.
 *   6. unlocks = direct / immediate (NOT transitive).
 *   7. P2-A is read-only (layer purity).
 *
 * Coverage: 24 tests (6 next + 7 why + 8 unlocks + 3 architecture).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  queryNextTasks,
  queryUnlocksTask,
  queryWhyTask,
  type TaskPresentation,
} from "./graph-query.ts";
import {
  affectedByCompletion,
  reverseDependencies,
  unsatisfiedDependencies,
} from "./graph.ts";
import { projectActiveView } from "./projection.ts";
import { buildDependencyPresentation } from "./read-model.ts";
import { normalizeTask, type Task, type TaskState } from "./types.ts";

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
): Task {
  return normalizeTask({
    subject: `task ${overrides.id}`,
    status: "pending",
    ...overrides,
  });
}

function mkState(...tasks: Task[]): TaskState {
  return { tasks: [...tasks], nextId: 1000 };
}

// ── A. queryNextTasks (6 tests) ────────────────────────────────────────

describe("queryNextTasks", () => {
  it("★ A1 empty state → tasks: []", () => {
    const out = queryNextTasks(mkState());
    assert.equal(out.kind, "next");
    assert.deepEqual([...out.tasks], []);
  });

  it("★ A2 only BLOCKED tasks → tasks: []", () => {
    // Chain: #2 pending (waiting on #3); #3 pending (waiting on #2).
    // Neither is READY (both have unsatisfied deps).
    const out = queryNextTasks(
      mkState(
        mkTask({ id: 2, status: "pending", blockedBy: [3] }),
        mkTask({ id: 3, status: "pending", blockedBy: [2] }),
      ),
    );
    assert.deepEqual([...out.tasks], []);
  });

  it("★ A3 only COMPLETED tasks → tasks: []", () => {
    const out = queryNextTasks(mkState(mkTask({ id: 1, status: "completed" })));
    assert.deepEqual([...out.tasks], []);
  });

  it("★ A4 mixed RUNNING + READY + BLOCKED → only READY in tasks", () => {
    const out = queryNextTasks(
      mkState(
        mkTask({ id: 1, status: "in_progress" }),
        mkTask({ id: 2, status: "pending" }),
        mkTask({ id: 3, status: "pending", blockedBy: [2] }),
      ),
    );
    assert.equal(out.tasks.length, 1);
    assert.equal(out.tasks[0]?.id, 2);
    assert.equal(out.tasks[0]?.role, "ready");
  });

  it("★ A5 V5 structural derivation equality: id sequence + each role='ready' + subject/status match", () => {
    const state = mkState(
      mkTask({ id: 5, status: "pending", subject: "alpha" }),
      mkTask({ id: 2, status: "pending", subject: "beta" }),
      mkTask({ id: 8, status: "pending", subject: "gamma" }),
      mkTask({ id: 1, status: "in_progress" }), // running — must not appear
      mkTask({ id: 9, status: "pending", blockedBy: [2] }), // blocked — must not appear
    );
    const out = queryNextTasks(state);
    const source = projectActiveView(state).ready;
    // Membership + order: id sequences identical.
    assert.deepEqual(
      out.tasks.map((t) => t.id),
      source.map((t) => t.id),
    );
    // Element-wise structural derivation.
    for (let i = 0; i < source.length; i++) {
      assert.equal(out.tasks[i]?.id, source[i]?.id);
      assert.equal(out.tasks[i]?.subject, source[i]?.subject);
      assert.equal(out.tasks[i]?.role, "ready");
    }
  });

  it("★ A6 archived READY excluded (inherited from projectActiveView)", () => {
    const out = queryNextTasks(
      mkState(
        mkTask({ id: 1, status: "pending", archivedAt: 100 }), // archived, hidden
        mkTask({ id: 2, status: "pending" }),
      ),
    );
    assert.equal(out.tasks.length, 1);
    assert.equal(out.tasks[0]?.id, 2);
  });
});

// ── B. queryWhyTask (7 tests) ──────────────────────────────────────────

describe("queryWhyTask", () => {
  it("★ B1 nonexistent id → not-found", () => {
    const out = queryWhyTask(mkState(), 99);
    assert.deepEqual(out, { kind: "not-found", id: 99 });
  });

  it("★ B2 deleted tombstone → not-found (tombstone policy)", () => {
    const out = queryWhyTask(mkState(mkTask({ id: 1, status: "deleted" })), 1);
    assert.deepEqual(out, { kind: "not-found", id: 1 });
  });

  it("★ B3 READY: kind=ready, no blocking field (Locks §4: never blocked + empty)", () => {
    // Locks the invariant: a pending task with no current blockers MUST
    // be READY, never BLOCKED + empty blocking.
    const out = queryWhyTask(
      mkState(
        mkTask({ id: 1, status: "completed" }), // satisfied
        mkTask({ id: 2, status: "pending", blockedBy: [1] }),
      ),
      2,
    );
    assert.equal(out.kind, "ready");
    assert.equal(out.task.id, 2);
    assert.equal(out.task.role, "ready");
    assert.ok(!("blocking" in out), "READY must NOT have blocking field");
  });

  it("★ B4 RUNNING: kind=running, no blocking field", () => {
    const out = queryWhyTask(
      mkState(mkTask({ id: 1, status: "in_progress" })),
      1,
    );
    assert.equal(out.kind, "running");
    assert.equal(out.task.role, "running");
    assert.ok(!("blocking" in out));
  });

  it("★ B5 COMPLETED: kind=completed, no blocking field", () => {
    const out = queryWhyTask(
      mkState(mkTask({ id: 1, status: "completed" })),
      1,
    );
    assert.equal(out.kind, "completed");
    assert.equal(out.task.role, "completed");
    assert.ok(!("blocking" in out));
  });

  it("★ B6 ARCHIVED: kind=archived (even if underlying completed), no blocking field", () => {
    // Locks precedence: archived > completed.
    const out = queryWhyTask(
      mkState(mkTask({ id: 1, status: "completed", archivedAt: 100 })),
      1,
    );
    assert.equal(out.kind, "archived");
    assert.equal(out.task.role, "archived");
    assert.ok(!("blocking" in out));
  });

  it("★ B7 BLOCKED with mixed deps: blocking only contains unsatisfied + broken", () => {
    // #20 depends on [99, 18, 17]:
    //   #99 missing  → broken
    //   #18 pending  → unsatisfied (waiting)
    //   #17 completed → satisfied (omitted)
    const out = queryWhyTask(
      mkState(
        mkTask({ id: 17, status: "completed" }),
        mkTask({ id: 18, status: "pending" }),
        mkTask({ id: 20, status: "pending", blockedBy: [99, 18, 17] }),
      ),
      20,
    );
    assert.equal(out.kind, "blocked");
    assert.equal(out.task.role, "blocked");
    // V6: blocking === buildDependencyPresentation(state, id)
    const expected = buildDependencyPresentation(
      mkState(
        mkTask({ id: 17, status: "completed" }),
        mkTask({ id: 18, status: "pending" }),
        mkTask({ id: 20, status: "pending", blockedBy: [99, 18, 17] }),
      ),
      20,
    );
    assert.deepEqual([...out.blocking], [...expected]);
    // And the concrete content:
    const ids = out.blocking.map((b) => b.id);
    assert.ok(ids.includes(99), "missing dep 99 must appear as broken");
    assert.ok(ids.includes(18), "pending dep 18 must appear as waiting");
    assert.ok(
      !ids.includes(17),
      "completed dep 17 must be omitted (satisfied)",
    );
  });
});

// ── C. queryUnlocksTask (8 tests) ──────────────────────────────────────

describe("queryUnlocksTask", () => {
  it("★ C1 nonexistent id → not-found", () => {
    const out = queryUnlocksTask(mkState(), 99);
    assert.deepEqual(out, { kind: "not-found", id: 99 });
  });

  it("★ C2 deleted tombstone → not-found", () => {
    const out = queryUnlocksTask(
      mkState(mkTask({ id: 1, status: "deleted" })),
      1,
    );
    assert.deepEqual(out, { kind: "not-found", id: 1 });
  });

  it("★ C3 COMPLETED: kind=completed, no unlocks field", () => {
    const out = queryUnlocksTask(
      mkState(mkTask({ id: 1, status: "completed" })),
      1,
    );
    assert.equal(out.kind, "completed");
    assert.equal(out.task.role, "completed");
    assert.ok(!("unlocks" in out));
  });

  it("★ C4 ARCHIVED: kind=archived (archived > completed), no unlocks field", () => {
    const out = queryUnlocksTask(
      mkState(mkTask({ id: 1, status: "completed", archivedAt: 100 })),
      1,
    );
    assert.equal(out.kind, "archived");
    assert.ok(!("unlocks" in out));
  });

  it("★ C5 READY with no reverse-deps → unlocks: []", () => {
    const out = queryUnlocksTask(
      mkState(mkTask({ id: 5, status: "pending" })),
      5,
    );
    assert.equal(out.kind, "unlocks");
    assert.equal(out.task.role, "ready");
    assert.deepEqual([...out.unlocks], []);
  });

  it("★ C6 READY with one direct reverse-dep → unlocks: [that dep]", () => {
    // #5 is ready; #10 is blocked only by #5. Finishing #5 unlocks #10.
    const out = queryUnlocksTask(
      mkState(
        mkTask({ id: 5, status: "pending" }),
        mkTask({ id: 10, status: "pending", blockedBy: [5] }),
      ),
      5,
    );
    assert.equal(out.kind, "unlocks");
    assert.equal(out.task.role, "ready");
    assert.equal(out.unlocks.length, 1);
    assert.equal(out.unlocks[0]?.id, 10);
    assert.equal(out.unlocks[0]?.role, "ready");
  });

  it("★ C7 BLOCKED task: task.role=blocked, unlocks still computed", () => {
    // #18 is blocked on #12; if #18 were completed, #19 (blocked only on #18)
    // would unlock.
    const out = queryUnlocksTask(
      mkState(
        mkTask({ id: 12, status: "pending" }),
        mkTask({ id: 18, status: "pending", blockedBy: [12] }),
        mkTask({ id: 19, status: "pending", blockedBy: [18] }),
      ),
      18,
    );
    assert.equal(out.kind, "unlocks");
    assert.equal(out.task.role, "blocked"); // current role, NOT "ready"
    assert.equal(out.unlocks.length, 1);
    assert.equal(out.unlocks[0]?.id, 19);
  });

  it("★ C8 transitive chain: direct effect only (Locks §8)", () => {
    // A → B → C: finishing A unlocks B (which was blocked only on A).
    // C remains blocked (still depends on B, which is now completed
    // but the chain semantics test focuses on the direct dep edge).
    //
    // Construct so that finishing A directly unblocks B (B's only dep is A).
    // C depends on B; once B is unblocked (pending, not completed), C is
    // still blocked. So unlocks(A) = [B], NOT [B, C].
    const out = queryUnlocksTask(
      mkState(
        mkTask({ id: 1, status: "pending" }), // A
        mkTask({ id: 2, status: "pending", blockedBy: [1] }), // B depends on A only
        mkTask({ id: 3, status: "pending", blockedBy: [2] }), // C depends on B only
      ),
      1,
    );
    assert.equal(out.kind, "unlocks");
    assert.equal(
      out.unlocks.length,
      1,
      "transitive descendant C must NOT appear",
    );
    assert.equal(out.unlocks[0]?.id, 2);
    // V7 structural derivation equality:
    const { newlySatisfied } = affectedByCompletion(
      mkState(
        mkTask({ id: 1, status: "pending" }),
        mkTask({ id: 2, status: "pending", blockedBy: [1] }),
        mkTask({ id: 3, status: "pending", blockedBy: [2] }),
      ),
      1,
    );
    assert.deepEqual(
      out.unlocks.map((t: TaskPresentation) => t.id),
      newlySatisfied.map((t) => t.id),
    );
  });
});

// ── D. Architecture (3 tests) ──────────────────────────────────────────

describe("graph-query: architecture", () => {
  it("★ D1 layer purity: graph-query.ts has no mutation / store / format imports", async () => {
    const src = await readFile("graph-query.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const forbidden = [
      "./reducer",
      "./store",
      "./format",
      "./mutation-command",
      "./mutation-selector",
      "./mutation-executor",
      "./mutation-outcome",
      "./mutation-format",
      "./mutation-wiring",
      "./index",
    ];
    for (const p of forbidden) {
      assert.ok(
        !code.includes(p),
        `graph-query.ts contains forbidden import "${p}"`,
      );
    }
  });

  it("★ D2 V6: when kind=blocked, blocking === buildDependencyPresentation(state, id)", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed" }),
      mkTask({ id: 2, status: "pending" }),
      mkTask({ id: 3, status: "pending" }),
      mkTask({ id: 10, status: "pending", blockedBy: [1, 2, 3] }),
    );
    const out = queryWhyTask(state, 10);
    assert.equal(out.kind, "blocked");
    assert.deepEqual(
      [...(out as Extract<typeof out, { kind: "blocked" }>).blocking],
      [...buildDependencyPresentation(state, 10)],
    );
  });

  it("★ D3 V7 structural derivation: unlocks[i] derived from newlySatisfied[i] with role=ready", () => {
    // Multi-element newlySatisfied (multiple direct dependents).
    const state = mkState(
      mkTask({ id: 100, status: "pending" }),
      mkTask({ id: 1, status: "pending", blockedBy: [100] }),
      mkTask({ id: 2, status: "pending", blockedBy: [100] }),
      mkTask({ id: 3, status: "pending", blockedBy: [100] }),
    );
    const out = queryUnlocksTask(state, 100);
    assert.equal(out.kind, "unlocks");
    const { newlySatisfied } = affectedByCompletion(state, 100);
    // ID order identical.
    assert.deepEqual(
      out.unlocks.map((t) => t.id),
      newlySatisfied.map((t) => t.id),
    );
    // Element-wise structural derivation.
    for (let i = 0; i < newlySatisfied.length; i++) {
      assert.equal(out.unlocks[i]?.id, newlySatisfied[i]?.id);
      assert.equal(out.unlocks[i]?.subject, newlySatisfied[i]?.subject);
      assert.equal(out.unlocks[i]?.role, "ready");
    }
    // Also verify no other status elements sneak in via reverseDependencies.
    const allRev = reverseDependencies(state, 100);
    assert.ok(
      allRev.length >= newlySatisfied.length,
      "newlySatisfied should be a subset of reverseDependencies",
    );
    // And unsatisfiedDependencies for the dependents confirms the gate.
    for (const d of newlySatisfied) {
      const unsat = unsatisfiedDependencies(state, d.id);
      assert.ok(
        unsat.length === 0 || (unsat.length === 1 && unsat[0]?.id === 100),
        `dependent ${d.id} should be unsatisfied only by 100`,
      );
    }
  });
});
