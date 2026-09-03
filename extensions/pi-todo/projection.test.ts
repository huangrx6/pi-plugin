/**
 * Unit tests for projection.ts — pure view layer (P0-B / B1).
 *
 * Scope (LOCKED B1):
 *   - classifyTask: status × dep × archived combinations → role or undefined
 *   - projectActiveView: grouping + sorting + counts
 *   - projectCompleted: completed+visible only
 *   - projectArchived: archived, not deleted
 *   - projectAll: non-deleted only (visible + archived, NOT raw state)
 *   - diffActiveView: neutral membership-based diff
 *   - layer purity: no reducer import, no state mutation, no clock
 *
 * Out of scope (later P0-B phases or P1):
 *   - formatTaskRow / formatTaskDetail / formatTodosSnapshot  (B2)
 *   - /todos read command wiring                            (B3)
 *   - overlay widget rewrite                                (B4)
 *   - mutation delta formatter (Now ready / Re-blocked)     (P1)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  classifyTask,
  diffActiveView,
  projectActiveView,
  projectAll,
  projectArchived,
  projectCompleted,
  selectAllTaskIds,
  selectArchivedTaskIds,
  selectCompletedTaskIds,
} from "./projection.ts";
import { normalizeTask } from "./types.ts";
import type { Task, TaskState } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function mkTask(overrides: Partial<Task> & { id: number }): Task {
  return normalizeTask({
    subject: `task ${overrides.id}`,
    status: "pending",
    ...overrides,
  });
}

function mkState(...tasks: Task[]): TaskState {
  return { tasks: [...tasks], nextId: 1000 };
}

// ── classifyTask ─────────────────────────────────────────────────────────

describe("classifyTask", () => {
  it("in_progress visible → running", () => {
    const state = mkState();
    const t = mkTask({ id: 17, status: "in_progress" });
    assert.equal(classifyTask(state, t), "running");
  });

  it("in_progress + archived (legacy) → undefined", () => {
    const state = mkState();
    const t = mkTask({
      id: 17,
      status: "in_progress",
      archivedAt: 500,
    });
    assert.equal(classifyTask(state, t), undefined);
  });

  it("pending visible, no deps → ready", () => {
    const t = mkTask({ id: 17, status: "pending" });
    const state = mkState(t); // task must be in state for dep lookup
    assert.equal(classifyTask(state, t), "ready");
  });

  it("pending visible, completed dep → ready", () => {
    const state = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const t18 = state.tasks[1] as Task;
    assert.equal(classifyTask(state, t18), "ready");
  });

  it("pending visible, pending dep → blocked", () => {
    const state = mkState(
      mkTask({ id: 17, status: "pending" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const t18 = state.tasks[1] as Task;
    assert.equal(classifyTask(state, t18), "blocked");
  });

  it("pending visible, broken (missing) dep → blocked", () => {
    const state = mkState(
      mkTask({ id: 18, status: "pending", blockedBy: [999] }),
    );
    const t18 = state.tasks[0] as Task;
    assert.equal(classifyTask(state, t18), "blocked");
  });

  it("pending visible, broken (deleted) dep → blocked", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const t18 = state.tasks[1] as Task;
    assert.equal(classifyTask(state, t18), "blocked");
  });

  it("★ pending + archived → undefined (A2.4 critical case)", () => {
    // Legal state from "archived completed + reopen" workflow.
    // Projection must NOT show it in active view.
    const state = mkState();
    const t = mkTask({
      id: 17,
      status: "pending",
      archivedAt: 500,
    });
    assert.equal(classifyTask(state, t), undefined);
  });

  it("completed visible → undefined (goes to projectCompleted)", () => {
    const state = mkState();
    const t = mkTask({ id: 17, status: "completed" });
    assert.equal(classifyTask(state, t), undefined);
  });

  it("completed + archived → undefined", () => {
    const state = mkState();
    const t = mkTask({
      id: 17,
      status: "completed",
      archivedAt: 500,
    });
    assert.equal(classifyTask(state, t), undefined);
  });

  it("deleted → undefined (tombstone, never active)", () => {
    const state = mkState();
    const t = mkTask({ id: 17, status: "deleted" });
    assert.equal(classifyTask(state, t), undefined);
  });

  it("deleted + archived (legacy weird) → undefined", () => {
    const state = mkState();
    const t = mkTask({
      id: 17,
      status: "deleted",
      archivedAt: 500,
    });
    assert.equal(classifyTask(state, t), undefined);
  });
});

// ── projectActiveView ────────────────────────────────────────────────────

describe("projectActiveView", () => {
  it("empty state → all empty, counts 0/0", () => {
    const v = projectActiveView(mkState());
    assert.deepEqual(v.running, []);
    assert.deepEqual(v.ready, []);
    assert.deepEqual(v.blocked, []);
    assert.equal(v.counts.active, 0);
    assert.equal(v.counts.completedVisible, 0);
  });

  it("4-status mix: 3 buckets + completed excluded", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, status: "pending" }),
      mkTask({ id: 3, status: "pending", blockedBy: [1] }), // #1 in_progress ≠ completed
      mkTask({ id: 4, status: "completed" }),
    );
    const v = projectActiveView(state);
    // #1 in_progress → running
    assert.equal(v.running.length, 1);
    assert.equal(v.running[0]?.id, 1);
    // #2 pending, no deps → ready
    assert.equal(v.ready.length, 1);
    assert.equal(v.ready[0]?.id, 2);
    // #3 pending, #1 not completed → blocked
    assert.equal(v.blocked.length, 1);
    assert.equal(v.blocked[0]?.id, 3);
    // #4 completed NOT in any bucket
    assert.equal(v.counts.active, 3);
    assert.equal(v.counts.completedVisible, 1);
  });

  it("★ pending + archived NOT in any bucket (A2.4 critical case)", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({
        id: 2,
        status: "pending",
        archivedAt: 500, // legal: pending+archived
      }),
      mkTask({ id: 3, status: "pending" }),
    );
    const v = projectActiveView(state);
    assert.equal(v.running.length, 1);
    assert.equal(v.running[0]?.id, 1);
    assert.equal(v.ready.length, 1);
    assert.equal(v.ready[0]?.id, 3); // #2 skipped
    assert.equal(v.blocked.length, 0);
    assert.equal(v.counts.active, 2);
  });

  it("deleted task NOT in any bucket", () => {
    const state = mkState(
      mkTask({ id: 1, status: "deleted" }),
      mkTask({ id: 2, status: "pending" }),
    );
    const v = projectActiveView(state);
    assert.equal(v.counts.active, 1);
    assert.equal(v.ready[0]?.id, 2);
  });

  it("completed task NOT in any bucket; counted in completedVisible", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed" }),
      mkTask({ id: 2, status: "completed" }),
      mkTask({ id: 3, status: "pending" }),
    );
    const v = projectActiveView(state);
    assert.equal(v.counts.active, 1);
    assert.equal(v.counts.completedVisible, 2);
  });

  it("completed + archived NOT counted in completedVisible", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed" }),
      mkTask({ id: 2, status: "completed", archivedAt: 100 }),
    );
    const v = projectActiveView(state);
    assert.equal(v.counts.completedVisible, 1);
  });

  it("running sort: updatedAt desc, id asc tie-breaker", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress", updatedAt: 200 }),
      mkTask({ id: 2, status: "in_progress", updatedAt: 500 }),
      mkTask({ id: 3, status: "in_progress", updatedAt: 200 }), // same as #1
    );
    const v = projectActiveView(state);
    // #2 first (highest updatedAt), then #1 and #3 (same, sorted by id asc)
    assert.deepEqual(
      v.running.map((t) => t.id),
      [2, 1, 3],
    );
  });

  it("ready sort: createdAt asc, id asc tie-breaker", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending", createdAt: 500 }),
      mkTask({ id: 2, status: "pending", createdAt: 100 }),
      mkTask({ id: 3, status: "pending", createdAt: 500 }), // same as #1
    );
    const v = projectActiveView(state);
    // #2 first (earliest), then #1 and #3 (same, by id asc)
    assert.deepEqual(
      v.ready.map((t) => t.id),
      [2, 1, 3],
    );
  });

  it("blocked sort: broken first", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending", blockedBy: [2] }), // normal blocked
      mkTask({ id: 3, status: "pending", blockedBy: [999] }), // broken (missing ref)
    );
    // Make #2 exists so #1 isn't broken.
    state.tasks.unshift(mkTask({ id: 2, status: "pending" }));
    const v = projectActiveView(state);
    // #3 (broken) comes first
    assert.equal(v.blocked[0]?.id, 3);
  });

  it("blocked sort: unsatisfied direct count asc", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending" }),
      mkTask({ id: 2, status: "pending" }),
      mkTask({ id: 3, status: "pending" }),
      mkTask({ id: 4, status: "pending", blockedBy: [1] }),
      mkTask({ id: 5, status: "pending", blockedBy: [1, 2, 3] }),
    );
    const v = projectActiveView(state);
    // #4 has 1 unsatisfied dep (#1 pending), #5 has 3
    assert.equal(v.blocked[0]?.id, 4); // count asc
    assert.equal(v.blocked[1]?.id, 5);
  });

  it("blocked sort: createdAt asc, id asc tie-breakers", () => {
    const state = mkState(
      mkTask({ id: 10, status: "pending" }),
      mkTask({ id: 11, status: "pending" }),
      mkTask({ id: 1, status: "pending", blockedBy: [10] }),
      mkTask({ id: 2, status: "pending", blockedBy: [11] }),
    );
    const v = projectActiveView(state);
    // Both have 1 unsatisfied dep; tie-break by createdAt asc → #1 (createdAt=0)
    // before #2 (createdAt=0 too); then id asc: #1 before #2
    assert.deepEqual(
      v.blocked.map((t) => t.id),
      [1, 2],
    );
  });

  it("counts.active = sum of bucket lengths", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, status: "pending" }),
      mkTask({ id: 3, status: "pending", blockedBy: [1] }),
      mkTask({ id: 4, status: "pending" }),
    );
    const v = projectActiveView(state);
    assert.equal(v.counts.active, 4);
    assert.equal(v.running.length + v.ready.length + v.blocked.length, 4);
  });
});

// ── projectCompleted ─────────────────────────────────────────────────────

describe("projectCompleted", () => {
  it("empty state → []", () => {
    assert.deepEqual(projectCompleted(mkState()), []);
  });

  it("includes completed + !archived", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed" }),
      mkTask({ id: 2, status: "completed" }),
    );
    const out = projectCompleted(state);
    assert.equal(out.length, 2);
  });

  it("excludes pending, in_progress, completed+archived, deleted", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending" }),
      mkTask({ id: 2, status: "in_progress" }),
      mkTask({ id: 3, status: "completed", archivedAt: 100 }), // archived
      mkTask({ id: 4, status: "deleted" }),
      mkTask({ id: 5, status: "completed" }),
    );
    const out = projectCompleted(state);
    assert.deepEqual(
      out.map((t) => t.id),
      [5],
    );
  });

  it("sort: updatedAt desc, id asc tie-breaker", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed", updatedAt: 200 }),
      mkTask({ id: 2, status: "completed", updatedAt: 500 }),
      mkTask({ id: 3, status: "completed", updatedAt: 200 }),
    );
    const out = projectCompleted(state);
    assert.deepEqual(
      out.map((t) => t.id),
      [2, 1, 3],
    );
  });
});

// ── projectArchived ──────────────────────────────────────────────────────

describe("projectArchived", () => {
  it("empty state → []", () => {
    assert.deepEqual(projectArchived(mkState()), []);
  });

  it("includes archivedAt set, any status (excl. deleted)", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending", archivedAt: 100 }),
      mkTask({ id: 2, status: "in_progress", archivedAt: 200 }),
      mkTask({ id: 3, status: "completed", archivedAt: 300 }),
    );
    const out = projectArchived(state);
    assert.equal(out.length, 3);
  });

  it("excludes deleted tombstones", () => {
    const state = mkState(
      mkTask({ id: 1, status: "deleted", archivedAt: 100 }),
      mkTask({ id: 2, status: "completed", archivedAt: 200 }),
    );
    const out = projectArchived(state);
    assert.deepEqual(
      out.map((t) => t.id),
      [2],
    );
  });

  it("excludes visible (non-archived) tasks", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending" }),
      mkTask({ id: 2, status: "completed" }),
    );
    assert.deepEqual(projectArchived(state), []);
  });

  it("sort: archivedAt desc, id asc tie-breaker", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed", archivedAt: 100 }),
      mkTask({ id: 2, status: "completed", archivedAt: 300 }),
      mkTask({ id: 3, status: "completed", archivedAt: 100 }),
    );
    const out = projectArchived(state);
    assert.deepEqual(
      out.map((t) => t.id),
      [2, 1, 3],
    );
  });
});

// ── projectAll ───────────────────────────────────────────────────────────

describe("projectAll", () => {
  it("empty state → []", () => {
    assert.deepEqual(projectAll(mkState()), []);
  });

  it("★ includes visible + archived, EXCLUDES deleted", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending" }),
      mkTask({ id: 2, status: "in_progress" }),
      mkTask({ id: 3, status: "completed" }),
      mkTask({ id: 4, status: "pending", archivedAt: 100 }),
      mkTask({ id: 5, status: "completed", archivedAt: 200 }),
      mkTask({ id: 6, status: "deleted" }), // excluded
    );
    const out = projectAll(state);
    assert.deepEqual(
      out.map((t) => t.id),
      [1, 2, 3, 4, 5],
    );
  });

  it("★ pending + archived IS in projectAll (the critical A2.4 case)", () => {
    const state = mkState(
      mkTask({ id: 17, status: "pending", archivedAt: 100 }),
    );
    const out = projectAll(state);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, 17);
  });

  it("★ pending + archived NOT in projectActiveView (visibility \u2260 raw state)", () => {
    const state = mkState(
      mkTask({ id: 17, status: "pending", archivedAt: 100 }),
    );
    const all = projectAll(state);
    const active = projectActiveView(state);
    assert.equal(all.length, 1); // in all
    assert.equal(active.counts.active, 0); // NOT in active
  });

  it("sort: createdAt asc, id asc tie-breaker", () => {
    const state = mkState(
      mkTask({ id: 2, status: "pending", createdAt: 200 }),
      mkTask({ id: 1, status: "pending", createdAt: 100 }),
      mkTask({ id: 3, status: "pending", createdAt: 200 }),
    );
    const out = projectAll(state);
    assert.deepEqual(
      out.map((t) => t.id),
      [1, 2, 3],
    );
  });
});

// ── diffActiveView ───────────────────────────────────────────────────────

describe("diffActiveView", () => {
  it("identity (same state) → both empty", () => {
    const state = mkState(
      mkTask({ id: 17, status: "in_progress" }),
      mkTask({ id: 18, status: "pending" }),
    );
    const diff = diffActiveView(state, state);
    assert.deepEqual(diff.becameReady, []);
    assert.deepEqual(diff.becameBlocked, []);
  });

  it("★ subject edit only → both empty (membership-based, not equality)", () => {
    // Same status, same deps \u2014 only subject changed. diff must NOT fire.
    const prev = mkState(mkTask({ id: 17, status: "pending", subject: "old" }));
    const next = mkState(mkTask({ id: 17, status: "pending", subject: "new" }));
    const diff = diffActiveView(prev, next);
    assert.deepEqual(diff.becameReady, []);
    assert.deepEqual(diff.becameBlocked, []);
  });

  it("★ finish: blocked \u2192 ready (becameReady contains it)", () => {
    // #17 in_progress, #18 blockedBy [17] \u2192 #18 was blocked.
    // finish #17 \u2192 #18 deps satisfied \u2192 #18 now ready.
    const prev = mkState(
      mkTask({ id: 17, status: "in_progress" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const next = mkState(
      mkTask({ id: 17, status: "completed", updatedAt: 999 }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const diff = diffActiveView(prev, next);
    assert.deepEqual(
      diff.becameReady.map((t) => t.id),
      [18],
    );
    assert.deepEqual(diff.becameBlocked, []);
  });

  it("★ reopen: ready \u2192 blocked (becameBlocked contains dependent)", () => {
    // #17 completed (with #18 visible+ready). Reopen #17 \u2192 #18 becomes blocked.
    // Note: #17 itself may also enter READY (if no deps) \u2014 but projection only
    // tracks becameReady / becameBlocked. The fact that #17 moved is in
    // diff.becameReady (since it was completed \u2192 not active in prev, now
    // pending+ready in next).
    const prev = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const next = mkState(
      mkTask({ id: 17, status: "pending", updatedAt: 999 }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const diff = diffActiveView(prev, next);
    assert.deepEqual(
      diff.becameBlocked.map((t) => t.id),
      [18],
    );
    // #17 became ready (it was completed \u2192 not in active; now in active).
    assert.deepEqual(
      diff.becameReady.map((t) => t.id),
      [17],
    );
  });

  it("create: new pending no-deps task \u2192 becameReady", () => {
    const prev = mkState();
    const next = mkState(mkTask({ id: 17, status: "pending" }));
    const diff = diffActiveView(prev, next);
    assert.deepEqual(
      diff.becameReady.map((t) => t.id),
      [17],
    );
    assert.deepEqual(diff.becameBlocked, []);
  });

  it("archive: task leaves active view (NOT in becameReady/becameBlocked)", () => {
    // archive a ready task \u2014 it disappears from active, but the diff
    // doesn't fire because the formatter will know via op context that
    // the user just archived it.
    const prev = mkState(mkTask({ id: 17, status: "pending" }));
    const next = mkState(
      mkTask({ id: 17, status: "pending", archivedAt: 500 }),
    );
    const diff = diffActiveView(prev, next);
    assert.deepEqual(diff.becameReady, []);
    assert.deepEqual(diff.becameBlocked, []);
  });

  it("restore: pending+archived \u2192 ready (becameReady if deps satisfied)", () => {
    const prev = mkState(
      mkTask({ id: 17, status: "pending", archivedAt: 500 }),
    );
    const next = mkState(mkTask({ id: 17, status: "pending" }));
    const diff = diffActiveView(prev, next);
    assert.deepEqual(
      diff.becameReady.map((t) => t.id),
      [17],
    );
  });

  it("delete: task leaves active view (NOT in becameReady/becameBlocked)", () => {
    const prev = mkState(mkTask({ id: 17, status: "in_progress" }));
    const next = mkState(mkTask({ id: 17, status: "deleted", updatedAt: 999 }));
    const diff = diffActiveView(prev, next);
    assert.deepEqual(diff.becameReady, []);
    assert.deepEqual(diff.becameBlocked, []);
  });

  it("both transitions: a task becomes ready AND another becomes blocked", () => {
    // Two parallel chains: finish one and reopen another.
    // finish #1: #3 (was blocked on #1) becomes ready.
    // reopen #2: #4 (was ready, blocked on completed #2) becomes blocked;
    //             #2 itself (was completed → not active) becomes ready.
    const prev = mkState(
      mkTask({ id: 1, status: "in_progress" }), // about to finish
      mkTask({ id: 2, status: "completed" }), // about to reopen
      mkTask({ id: 3, status: "pending", blockedBy: [1] }),
      mkTask({ id: 4, status: "pending", blockedBy: [2] }),
    );
    const next = mkState(
      mkTask({ id: 1, status: "completed", updatedAt: 999 }),
      mkTask({ id: 2, status: "pending", updatedAt: 999 }),
      mkTask({ id: 3, status: "pending", blockedBy: [1] }),
      mkTask({ id: 4, status: "pending", blockedBy: [2] }),
    );
    const diff = diffActiveView(prev, next);
    // Both #2 and #3 become ready; #4 becomes blocked.
    assert.deepEqual(diff.becameReady.map((t) => t.id).sort(), [2, 3]);
    assert.deepEqual(
      diff.becameBlocked.map((t) => t.id),
      [4],
    );
  });

  it("only becameReady (no becameBlocked) when deps satisfy but no deps unsatisfy", () => {
    const prev = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, status: "pending", blockedBy: [1] }),
      mkTask({ id: 3, status: "pending" }),
    );
    const next = mkState(
      mkTask({ id: 1, status: "completed", updatedAt: 999 }),
      mkTask({ id: 2, status: "pending", blockedBy: [1] }),
      mkTask({ id: 3, status: "pending" }),
    );
    const diff = diffActiveView(prev, next);
    assert.deepEqual(
      diff.becameReady.map((t) => t.id),
      [2],
    );
    assert.deepEqual(diff.becameBlocked, []);
  });
});

// ── selectXxxTaskIds: structural derivation invariant (P1-A mutual contract) ──

describe("selectXxxTaskIds (P1-A shared canonical id-only queries)", () => {
  it("selectCompletedTaskIds === projectCompleted(state).map(t.id) — structural single-source", () => {
    const state = mkState(
      mkTask({ id: 1, subject: "completed", status: "completed" }),
      mkTask({
        id: 2,
        subject: "archived",
        status: "completed",
        archivedAt: 100,
      }),
      mkTask({ id: 3, subject: "pending", status: "pending" }),
      mkTask({ id: 4, subject: "in_progress", status: "in_progress" }),
      mkTask({ id: 5, subject: "deleted", status: "deleted" }),
    );
    const ids = selectCompletedTaskIds(state);
    const projected = projectCompleted(state).map((t) => t.id);
    assert.deepEqual(ids, projected);
  });

  it("selectArchivedTaskIds === projectArchived(state).map(t.id)", () => {
    const state = mkState(
      mkTask({ id: 1, subject: "completed", status: "completed" }),
      mkTask({
        id: 2,
        subject: "archived_pending",
        status: "pending",
        archivedAt: 100,
      }),
      mkTask({
        id: 3,
        subject: "archived_completed",
        status: "completed",
        archivedAt: 200,
      }),
      mkTask({ id: 4, subject: "deleted", status: "deleted", archivedAt: 300 }),
    );
    const ids = selectArchivedTaskIds(state);
    const projected = projectArchived(state).map((t) => t.id);
    assert.deepEqual(ids, projected);
  });

  it("selectAllTaskIds === projectAll(state).map(t.id)", () => {
    const state = mkState(
      mkTask({ id: 1, subject: "completed", status: "completed" }),
      mkTask({ id: 2, subject: "pending", status: "pending" }),
      mkTask({ id: 3, subject: "deleted", status: "deleted" }),
    );
    const ids = selectAllTaskIds(state);
    const projected = projectAll(state).map((t) => t.id);
    assert.deepEqual(ids, projected);
  });
});

// ── Layer purity ─────────────────────────────────────────────────────────

describe("projection.ts layer purity", () => {
  it("does not import from reducer.ts (read vs mutation layer boundary)", async () => {
    const src = await readFile("projection.ts", "utf8");
    assert.ok(
      !src.includes('from "./reducer"'),
      "projection.ts must not import from reducer.ts (read vs mutation layer boundary)",
    );
  });

  it("does not reference mutation vocabulary in code", async () => {
    const src = await readFile("projection.ts", "utf8");
    // Strip comments (block + line) so doc text mentioning
    // "mutation" doesn't trip the check.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // None of these should appear in projection code:
    const forbidden = [
      "ApplyResult",
      "MutationError",
      "ReduceContext",
      "TaskMutationParams",
      "Op ",
    ];
    for (const tok of forbidden) {
      assert.ok(
        !code.includes(tok),
        `projection.ts contains forbidden mutation-layer token "${tok}"`,
      );
    }
  });
});
