/**
 * Unit tests for read-model.ts (P0-B / B3 shared helper).
 *
 * Critical invariants tested:
 *   1. Preserves ORIGINAL blockedBy declaration order (not graph order).
 *   2. Excludes completed deps (satisfied; not rendered).
 *   3. Empty / missing task → [].
 *   4. Uses graph.unsatisfiedDependencies + graph.brokenDependencies
 *      as the source of truth for dep classification.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDependencyPresentation } from "./read-model.ts";
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("buildDependencyPresentation", () => {
  it("empty blockedBy → []", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(buildDependencyPresentation(state, 17), []);
  });

  it("non-existent taskId → []", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(buildDependencyPresentation(state, 999), []);
  });

  it("all completed → [] (satisfied deps not rendered)", () => {
    const state = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, status: "completed", blockedBy: [17] }),
    );
    assert.deepEqual(buildDependencyPresentation(state, 18), []);
  });

  it("all pending → all waiting (kind: waiting)", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 18 }),
      mkTask({ id: 19, blockedBy: [17, 18] }),
    );
    const out = buildDependencyPresentation(state, 19);
    assert.deepEqual(out, [
      { id: 17, kind: "waiting" },
      { id: 18, kind: "waiting" },
    ]);
  });

  it("mixed in_progress + pending → both waiting", () => {
    const state = mkState(
      mkTask({ id: 17, status: "in_progress" }),
      mkTask({ id: 18 }),
      mkTask({ id: 19, blockedBy: [17, 18] }),
    );
    const out = buildDependencyPresentation(state, 19);
    assert.deepEqual(out, [
      { id: 17, kind: "waiting" },
      { id: 18, kind: "waiting" },
    ]);
  });

  it("★ preserves ORIGINAL blockedBy declaration order", () => {
    // #20 blockedBy [99, 18, 17] in this order. Even though graph might
    // return them in a different order, the presentation must match
    // the user's declared order.
    //   #17 completed (omit), #18 in_progress (waiting), #99 missing (missing)
    // Expected: [{99, missing}, {18, waiting}]  (declaration order)
    const state = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, status: "in_progress" }),
      mkTask({ id: 20, blockedBy: [99, 18, 17] }),
    );
    const out = buildDependencyPresentation(state, 20);
    assert.deepEqual(out, [
      { id: 99, kind: "missing" },
      { id: 18, kind: "waiting" },
    ]);
  });

  it("★ mixed completed/waiting/missing/deleted: declaration order", () => {
    // blockedBy: [99(missing), 17(completed→omit), 18(in_progress→waiting), 88(deleted)]
    // Expected order matches declaration, completed dropped.
    const state = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, status: "in_progress" }),
      mkTask({ id: 88, status: "deleted" }),
      mkTask({ id: 30, blockedBy: [99, 17, 18, 88] }),
    );
    const out = buildDependencyPresentation(state, 30);
    assert.deepEqual(out, [
      { id: 99, kind: "missing" },
      { id: 18, kind: "waiting" },
      { id: 88, kind: "deleted" },
    ]);
  });

  it("missing dep (id not in state) → kind: missing", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 18, blockedBy: [999] }),
    );
    const out = buildDependencyPresentation(state, 18);
    assert.deepEqual(out, [{ id: 999, kind: "missing" }]);
  });

  it("deleted dep → kind: deleted", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    const out = buildDependencyPresentation(state, 18);
    assert.deepEqual(out, [{ id: 17, kind: "deleted" }]);
  });
});
