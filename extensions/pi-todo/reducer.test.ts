/**
 * Unit tests for reducer.ts — P0-A2.1: schema + time semantics.
 *
 * Scope (per A2.1 plan):
 *   - normalizeTask: legacy / untrusted snapshot migration
 *   - create action: sets createdAt = updatedAt = now
 *   - update action: bumps updatedAt ONLY on real change; no-op preserves
 *   - delete action: sets updatedAt on transition
 *   - clock injection: deterministic / varying
 *   - replayFromBranch: legacy vs v1 dispatch
 *
 * Out of scope (later sub-phases):
 *   - start / finish / reopen lifecycle actions (A2.3)
 *   - archive / restore visibility (A2.4)
 *   - delete reverse-dep guard (A2.4)
 *   - structured error codes (later A2 sub-phase)
 *   - formatMutationDelta (P1)
 *
 * Note on narrowing: discriminated union narrowing on `result.op.kind`
 * is done via `if (op.kind === "X") { ... }` block scope (not early
 * return + later access) — property-access flow analysis is fragile in
 * TypeScript when assert.equal appears in the same block.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyTaskMutation } from "./reducer.ts";
import { replayFromBranch } from "./store.ts";
import { EMPTY_STATE, normalizeTask } from "./types.ts";
import type { MutationError, ReduceContext, Task, TaskState } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function mkState(...tasks: Task[]): TaskState {
  return { tasks: [...tasks], nextId: 1000 };
}

function taskWithTimestamps(overrides: Partial<Task> & { id: number }): Task {
  return normalizeTask({
    subject: `task ${overrides.id}`,
    status: "pending",
    ...overrides,
  });
}

function fixedCtx(now: number): ReduceContext {
  return { now: () => now };
}

// ── normalizeTask (legacy migration) ────────────────────────────────────

describe("normalizeTask", () => {
  it("fills missing createdAt with 0", () => {
    const t = normalizeTask({ id: 17, subject: "x", status: "pending" });
    assert.equal(t.createdAt, 0);
    assert.equal(t.updatedAt, 0);
  });

  it("fills missing updatedAt with = createdAt", () => {
    const t = normalizeTask({
      id: 17,
      subject: "x",
      status: "pending",
      createdAt: 500,
    });
    assert.equal(t.createdAt, 500);
    assert.equal(t.updatedAt, 500);
  });

  it("preserves explicit timestamps when both present", () => {
    const t = normalizeTask({
      id: 17,
      subject: "x",
      status: "pending",
      createdAt: 500,
      updatedAt: 800,
    });
    assert.equal(t.createdAt, 500);
    assert.equal(t.updatedAt, 800);
  });

  it("preserves archivedAt when present", () => {
    const t = normalizeTask({
      id: 17,
      subject: "x",
      status: "completed",
      createdAt: 500,
      updatedAt: 800,
      archivedAt: 900,
    });
    assert.equal(t.archivedAt, 900);
  });

  it("archivedAt undefined when missing (visible by default)", () => {
    const t = normalizeTask({
      id: 17,
      subject: "x",
      status: "pending",
      createdAt: 500,
      updatedAt: 800,
    });
    assert.equal(t.archivedAt, undefined);
  });

  it("defaults missing subject to empty string", () => {
    const t = normalizeTask({ id: 17, status: "pending" });
    assert.equal(t.subject, "");
  });

  it("defaults missing status to pending", () => {
    const t = normalizeTask({ id: 17, subject: "x" });
    assert.equal(t.status, "pending");
  });

  it("preserves optional fields (description, blockedBy, metadata)", () => {
    const t = normalizeTask({
      id: 17,
      subject: "x",
      status: "pending",
      description: "long",
      blockedBy: [3, 5],
      metadata: { key: "value" },
    });
    assert.equal(t.description, "long");
    assert.deepEqual(t.blockedBy, [3, 5]);
    assert.deepEqual(t.metadata, { key: "value" });
  });
});

describe("unfinished task recovery", () => {
 it("close preserves unfinished semantics and records the reason", () => {
  const state = mkState(taskWithTimestamps({ id: 17, status: "in_progress" }));
  const result = applyTaskMutation(
   state,
   { action: "close", id: 17, closeReason: "用户决定暂缓" },
   fixedCtx(900),
  );
  assert.equal(result.op.kind, "close");
  const task = result.state.tasks[0];
  assert.equal(task?.status, "in_progress");
  assert.equal(task?.closedAt, 900);
  assert.equal(task?.closedReason, "用户决定暂缓");
 });

 it("reopen clears the close marker and returns the task to pending", () => {
  const state = mkState(taskWithTimestamps({ id: 17, status: "in_progress", closedAt: 800 }));
  const result = applyTaskMutation(state, { action: "reopen", id: 17 }, fixedCtx(900));
  assert.equal(result.op.kind, "reopen");
  const task = result.state.tasks[0];
  assert.equal(task?.status, "pending");
  assert.equal(task?.closedAt, undefined);
 });
});

// ── create timestamps ───────────────────────────────────────────────────

describe("create timestamps", () => {
  it("sets createdAt = updatedAt = now on create", () => {
    const result = applyTaskMutation(
      mkState(),
      { action: "create", subject: "do thing" },
      fixedCtx(12345),
    );
    if (result.op.kind === "create") {
      // Extract to local const so narrowing survives into the callback
      // (TS narrows in the immediate block only; closures can't see it).
      const newId = result.op.taskId;
      const created = result.state.tasks.find((t) => t.id === newId);
      assert.ok(created);
      assert.equal(created.createdAt, 12345);
      assert.equal(created.updatedAt, 12345);
    } else {
      assert.fail(`expected create op, got ${result.op.kind}`);
    }
  });

  it("different ctx.now produces different timestamps", () => {
    const r1 = applyTaskMutation(
      mkState(),
      { action: "create", subject: "a" },
      fixedCtx(100),
    );
    const r2 = applyTaskMutation(
      mkState(),
      { action: "create", subject: "b" },
      fixedCtx(200),
    );
    assert.equal(r1.state.tasks[0]?.createdAt, 100);
    assert.equal(r2.state.tasks[0]?.createdAt, 200);
  });

  it("rejected create (empty subject) does not bump any clock", () => {
    const r = applyTaskMutation(
      mkState(),
      { action: "create", subject: "   " },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks.length, 0);
  });
});

// ── update timestamps (A2 atomicity) ────────────────────────────────────

describe("update timestamps", () => {
  it("bumps updatedAt on real subject change; createdAt unchanged", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "old",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, subject: "new" },
      fixedCtx(999),
    );
    if (r.op.kind === "update") {
      assert.equal(r.op.changed, true);
      const updated = r.state.tasks[0];
      assert.ok(updated);
      assert.equal(updated.updatedAt, 999);
      assert.equal(updated.createdAt, 100);
      assert.equal(updated.subject, "new");
    } else {
      assert.fail(`expected update op, got ${r.op.kind}`);
    }
  });

  it("does NOT bump updatedAt on no-op (subject unchanged)", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "same",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, subject: "same" },
      fixedCtx(999),
    );
    if (r.op.kind === "update") {
      assert.equal(r.op.changed, false);
      assert.equal(r.state.tasks[0]?.updatedAt, 200);
    } else {
      assert.fail(`expected update op, got ${r.op.kind}`);
    }
  });

  it("does NOT bump updatedAt on no-op (status already pending)", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, status: "pending" },
      fixedCtx(999),
    );
    if (r.op.kind === "update") {
      assert.equal(r.op.changed, false);
      assert.equal(r.state.tasks[0]?.updatedAt, 200);
    } else {
      assert.fail(`expected update op, got ${r.op.kind}`);
    }
  });

  it("failed update (illegal transition) does not mutate state or timestamp", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, status: "in_progress" }, // completed → in_progress illegal
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks[0]?.status, "completed");
    assert.equal(r.state.tasks[0]?.updatedAt, 200);
    assert.equal(r.state.tasks[0]?.subject, "x");
  });

  it("failed update (no mutable fields) does not mutate", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks[0]?.updatedAt, 200);
  });

  it("atomicity: blockedBy invalid dep does not partially update", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [999] }, // 999 missing
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks[0]?.blockedBy, undefined);
    assert.equal(r.state.tasks[0]?.updatedAt, 200);
  });

  it("status transition pending → in_progress bumps updatedAt", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      {
        action: "update",
        id: 17,
        status: "in_progress",
        activeForm: "doing x",
      },
      fixedCtx(999),
    );
    if (r.op.kind === "update") {
      assert.equal(r.op.changed, true);
      assert.equal(r.state.tasks[0]?.status, "in_progress");
      assert.equal(r.state.tasks[0]?.updatedAt, 999);
      assert.equal(r.state.tasks[0]?.activeForm, "doing x");
    } else {
      assert.fail(`expected update op, got ${r.op.kind}`);
    }
  });
});

// ── delete timestamp ─────────────────────────────────────────────────────

describe("delete timestamp", () => {
  it("sets updatedAt on transition to deleted", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.state.tasks[0]?.status, "deleted");
    assert.equal(r.state.tasks[0]?.updatedAt, 999);
    assert.equal(r.state.tasks[0]?.createdAt, 100);
  });

  it("double-delete rejected (idempotent error); timestamp untouched", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "deleted",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks[0]?.updatedAt, 200);
  });
});

// ── clock injection ─────────────────────────────────────────────────────

describe("clock injection", () => {
  it("deterministic with fixed now()", () => {
    const ctx = fixedCtx(500);
    const r1 = applyTaskMutation(
      mkState(),
      { action: "create", subject: "a" },
      ctx,
    );
    const r2 = applyTaskMutation(
      mkState(),
      { action: "create", subject: "b" },
      ctx,
    );
    assert.equal(r1.state.tasks[0]?.createdAt, 500);
    assert.equal(r2.state.tasks[0]?.createdAt, 500);
  });

  it("supports a varying clock (counter-style)", () => {
    let counter = 0;
    const ctx: ReduceContext = { now: () => ++counter };
    const r1 = applyTaskMutation(
      mkState(),
      { action: "create", subject: "a" },
      ctx,
    );
    const r2 = applyTaskMutation(
      mkState(),
      { action: "create", subject: "b" },
      ctx,
    );
    assert.equal(r1.state.tasks[0]?.createdAt, 1);
    assert.equal(r2.state.tasks[0]?.createdAt, 2);
  });
});

// ── legacy snapshot replay ──────────────────────────────────────────────

describe("replayFromBranch legacy normalization", () => {
  function branchWith(...details: unknown[]) {
    return {
      sessionManager: {
        getBranch: () =>
          details.map((d) => ({
            type: "message",
            message: {
              role: "toolResult",
              toolName: "todo",
              details: d,
            },
          })),
      },
    };
  }

  it("legacy snapshot (no schemaVersion): tasks get timestamps defaulted", () => {
    const result = replayFromBranch(
      branchWith({
        tasks: [{ id: 17, subject: "old", status: "pending" }],
        nextId: 18,
      }),
    );
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0]?.createdAt, 0);
    assert.equal(result.tasks[0]?.updatedAt, 0);
  });

  it("v1 snapshot (schemaVersion: 1): tasks keep their timestamps", () => {
    const result = replayFromBranch(
      branchWith({
        schemaVersion: 1,
        tasks: [
          {
            id: 17,
            subject: "new",
            status: "pending",
            createdAt: 1000,
            updatedAt: 1500,
          },
        ],
        nextId: 18,
      }),
    );
    assert.equal(result.tasks[0]?.createdAt, 1000);
    assert.equal(result.tasks[0]?.updatedAt, 1500);
  });

  it("empty branch: returns EMPTY_STATE", () => {
    const result = replayFromBranch(branchWith());
    assert.deepEqual(result, EMPTY_STATE);
  });

  it("non-message / non-toolResult entries: skipped", () => {
    const ctx = {
      sessionManager: {
        getBranch: () => [
          { type: "user", message: { role: "user" } },
          {
            type: "message",
            message: { role: "assistant", toolName: "other" },
          },
          {
            type: "message",
            message: { role: "toolResult", toolName: "todo" },
          }, // missing details
        ],
      },
    };
    assert.deepEqual(replayFromBranch(ctx), EMPTY_STATE);
  });

  it("last valid snapshot wins (newest overrides older)", () => {
    const result = replayFromBranch(
      branchWith(
        {
          tasks: [{ id: 1, subject: "first", status: "pending" }],
          nextId: 2,
        },
        {
          schemaVersion: 1,
          tasks: [
            {
              id: 1,
              subject: "second",
              status: "completed",
              createdAt: 500,
              updatedAt: 600,
            },
          ],
          nextId: 2,
        },
      ),
    );
    assert.equal(result.tasks[0]?.subject, "second");
    assert.equal(result.tasks[0]?.status, "completed");
    assert.equal(result.tasks[0]?.updatedAt, 600);
  });
});

// ── P0-A2.2 — blockedBy write invariants + structured errors ───────────

import { dedupeBlockedBy, normalizeAndValidateBlockedBy } from "./reducer.ts";
import { formatMutationError } from "./format.ts";
import { dependenciesSatisfied } from "./graph.ts";

describe("dedupeBlockedBy", () => {
  it("dedupes preserving first occurrence order", () => {
    assert.deepEqual(dedupeBlockedBy([17, 19, 17, 20, 19]), [17, 19, 20]);
  });
  it("returns empty for empty input", () => {
    assert.deepEqual(dedupeBlockedBy([]), []);
  });
  it("passes through already-unique ids unchanged", () => {
    assert.deepEqual(dedupeBlockedBy([1, 2, 3]), [1, 2, 3]);
  });
  it("collapses a single repeated id", () => {
    assert.deepEqual(dedupeBlockedBy([5, 5, 5]), [5]);
  });
});

describe("normalizeAndValidateBlockedBy", () => {
  function stateWith(...tasks: Task[]): TaskState {
    return { tasks: [...tasks], nextId: 100 };
  }

  it("undefined / empty blockedBy → ok with empty value", () => {
    const r1 = normalizeAndValidateBlockedBy(stateWith(), 17, undefined);
    const r2 = normalizeAndValidateBlockedBy(stateWith(), 17, []);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (r1.ok) assert.deepEqual(r1.value, []);
    if (r2.ok) assert.deepEqual(r2.value, []);
  });

  it("valid deps → ok with cleaned (deduped) value", () => {
    const state = stateWith(
      taskWithTimestamps({ id: 17 }),
      taskWithTimestamps({ id: 18 }),
      taskWithTimestamps({ id: 19 }),
    );
    const r = normalizeAndValidateBlockedBy(state, 30, [17, 18, 17, 19]);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, [17, 18, 19]);
  });

  it("self-loop → DEPENDENCY_SELF", () => {
    const state = stateWith(taskWithTimestamps({ id: 17 }));
    const r = normalizeAndValidateBlockedBy(state, 17, [17]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_SELF");
      if (r.error.code === "DEPENDENCY_SELF") {
        assert.equal(r.error.depId, 17);
      }
    }
  });

  it("self-loop in mixed input: self-check fires first (before existence)", () => {
    const state = stateWith(taskWithTimestamps({ id: 17 }));
    const r = normalizeAndValidateBlockedBy(state, 17, [999, 17]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_SELF");
    }
  });

  it("missing dep → DEPENDENCY_NOT_FOUND", () => {
    const state = stateWith(taskWithTimestamps({ id: 17 }));
    const r = normalizeAndValidateBlockedBy(state, 30, [17, 999]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_NOT_FOUND");
      if (r.error.code === "DEPENDENCY_NOT_FOUND") {
        assert.equal(r.error.depId, 999);
      }
    }
  });

  it("deleted dep → DEPENDENCY_DELETED (NOT in unsatisfied, NOT_FOUND vs DELETED partition)", () => {
    const state = stateWith(
      taskWithTimestamps({ id: 17 }),
      taskWithTimestamps({ id: 18, status: "deleted" }),
    );
    const r = normalizeAndValidateBlockedBy(state, 30, [17, 18]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_DELETED");
      if (r.error.code === "DEPENDENCY_DELETED") {
        assert.equal(r.error.depId, 18);
      }
    }
  });

  it("pending cycle: addBlockedBy chain → DEPENDENCY_CYCLE", () => {
    const state = stateWith(
      taskWithTimestamps({ id: 17 }),
      taskWithTimestamps({ id: 18, blockedBy: [17] }),
      taskWithTimestamps({ id: 19, blockedBy: [18] }),
    );
    // #19 already blockedBy [18]; adding [17] would close 17→19→18→17 (cycle).
    const r = normalizeAndValidateBlockedBy(state, 17, [19]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_CYCLE");
      if (r.error.code === "DEPENDENCY_CYCLE") {
        assert.deepEqual(r.error.attempted, [19]);
      }
    }
  });

  it("dangling-edge cycle: candidate includes dangling id → cycle via raw walk", () => {
    const state = stateWith(taskWithTimestamps({ id: 17, blockedBy: [999] }));
    // #17 blockedBy [999 missing]; new taskId=999 with [17] closes 999→17→999.
    const r = normalizeAndValidateBlockedBy(state, 999, [17]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_CYCLE");
    }
  });

  it("checks happen on DEDUPED list, not raw input", () => {
    const state = stateWith(taskWithTimestamps({ id: 17 }));
    // [999, 999, 17] dedupes to [999, 17]; 999 is missing → NOT_FOUND.
    const r = normalizeAndValidateBlockedBy(state, 30, [999, 999, 17]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "DEPENDENCY_NOT_FOUND");
      if (r.error.code === "DEPENDENCY_NOT_FOUND") {
        assert.equal(r.error.depId, 999);
      }
    }
  });
});

// ── create + update with blockedBy (structured errors) ─────────────────

describe("create with blockedBy", () => {
  it("valid deps → created with deduped blockedBy", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17 }),
      taskWithTimestamps({ id: 18 }),
    );
    const r = applyTaskMutation(
      state,
      {
        action: "create",
        subject: "new",
        blockedBy: [17, 18, 17],
      },
      fixedCtx(1000),
    );
    if (r.op.kind === "create") {
      const newId = r.op.taskId;
      const t = r.state.tasks.find((x) => x.id === newId);
      assert.ok(t);
      assert.deepEqual(t.blockedBy, [17, 18]); // deduped
      assert.equal(t.updatedAt, 1000);
    } else {
      assert.fail(`expected create op, got ${r.op.kind}`);
    }
  });

  it("self-loop → DEPENDENCY_SELF, state unchanged (atomicity)", () => {
    const state = mkState();
    const before = state;
    const r = applyTaskMutation(
      state,
      { action: "create", subject: "self-ref", blockedBy: [1000] },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state, before); // atomicity: state reference unchanged
    assert.equal(r.state.tasks.length, 0);
  });

  it("missing dep → DEPENDENCY_NOT_FOUND, state unchanged", () => {
    const state = mkState(taskWithTimestamps({ id: 17 }));
    const r = applyTaskMutation(
      state,
      { action: "create", subject: "x", blockedBy: [999] },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks.length, 1); // only the existing task
  });

  it("deleted dep → DEPENDENCY_DELETED, state unchanged", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "deleted" }));
    const r = applyTaskMutation(
      state,
      { action: "create", subject: "x", blockedBy: [17] },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks.length, 1);
  });

  it("cycle → DEPENDENCY_CYCLE, state unchanged", () => {
    // #1000 doesn't exist yet; new task id=1000 with blockedBy=[17]
    // walks 1000→17→1000 (raw edge id walk) and closes the cycle.
    const state = mkState(taskWithTimestamps({ id: 17, blockedBy: [1000] }));
    const r = applyTaskMutation(
      state,
      { action: "create", subject: "x", blockedBy: [17] },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks.length, 1);
  });

  it("empty / no blockedBy → created without blockedBy field", () => {
    const r = applyTaskMutation(
      mkState(),
      { action: "create", subject: "solo" },
      fixedCtx(1000),
    );
    if (r.op.kind === "create") {
      const newId = r.op.taskId;
      const t = r.state.tasks.find((x) => x.id === newId);
      assert.ok(t);
      assert.equal(t.blockedBy, undefined);
    } else {
      assert.fail(`expected create op, got ${r.op.kind}`);
    }
  });
});

describe("update with addBlockedBy", () => {
  it("valid add → blockedBy merged + deduped", () => {
    const state = mkState(
      taskWithTimestamps({ id: 3 }),
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        blockedBy: [3],
      }),
      taskWithTimestamps({ id: 18 }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [18, 18, 3] },
      fixedCtx(1000),
    );
    if (r.op.kind === "update") {
      assert.equal(r.op.changed, true);
      const updated = r.state.tasks.find((t) => t.id === 17);
      assert.ok(updated);
      assert.deepEqual(updated?.blockedBy, [3, 18]); // deduped: [3,18,18,3] → [3,18]
    } else {
      assert.fail(`expected update op, got ${r.op.kind}`);
    }
  });

  it("addBlockedBy + removeBlockedBy validates MERGED candidate", () => {
    // remove 3 (currently blockedBy), add 18; final = [18]
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        blockedBy: [3],
      }),
      taskWithTimestamps({ id: 18 }),
    );
    const r = applyTaskMutation(
      state,
      {
        action: "update",
        id: 17,
        addBlockedBy: [18],
        removeBlockedBy: [3],
      },
      fixedCtx(1000),
    );
    if (r.op.kind === "update") {
      const updated = r.state.tasks.find((t) => t.id === 17);
      assert.deepEqual(updated?.blockedBy, [18]);
    } else {
      assert.fail(`expected update op`);
    }
  });

  it("self-loop in addBlockedBy → DEPENDENCY_SELF", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "pending" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [17] },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "DEPENDENCY_SELF");
    }
  });

  it("missing dep in addBlockedBy → DEPENDENCY_NOT_FOUND, state unchanged", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "pending" }),
    );
    const before = JSON.stringify(state);
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [999] },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks[0]?.blockedBy, undefined);
    const original = state.tasks[0];
    assert.ok(original);
    assert.equal(JSON.stringify(r.state.tasks[0]), JSON.stringify(original)); // no partial write
    void before; // (assert above suffices; using string form for stable comparison)
  });

  it("cycle in addBlockedBy → DEPENDENCY_CYCLE, state unchanged", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        blockedBy: [3],
      }),
      taskWithTimestamps({
        id: 3,
        subject: "y",
        status: "pending",
        blockedBy: [17],
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [3] }, // 17→3 + existing 3→17 = cycle
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "DEPENDENCY_CYCLE");
    }
  });

  it("atomicity: failed blockedBy update doesn't bump updatedAt", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [999] },
      fixedCtx(9999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(r.state.tasks[0]?.updatedAt, 200); // NOT 9999
  });

  it("dedup in addBlockedBy produces clean final list", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "pending" }),
      taskWithTimestamps({ id: 18 }),
    );
    const r = applyTaskMutation(
      state,
      { action: "update", id: 17, addBlockedBy: [18, 18, 18] },
      fixedCtx(1000),
    );
    if (r.op.kind === "update") {
      const updated = r.state.tasks.find((t) => t.id === 17);
      assert.deepEqual(updated?.blockedBy, [18]);
    } else {
      assert.fail("expected update");
    }
  });
});

// ── structured error contract ───────────────────────────────────────────

describe("formatMutationError (reducer ↔ format contract)", () => {
  it("renders each variant with the Error: prefix and context", () => {
    assert.equal(
      formatMutationError({ code: "SUBJECT_REQUIRED" }),
      "Error: subject required for create",
    );
    assert.equal(
      formatMutationError({ code: "ID_REQUIRED" }),
      "Error: id required for this action",
    );
    assert.equal(
      formatMutationError({ code: "TASK_NOT_FOUND", id: 17 }),
      "Error: #17 not found",
    );
    assert.equal(
      formatMutationError({ code: "DEPENDENCY_NOT_FOUND", depId: 99 }),
      "Error: dependency #99 not found",
    );
    assert.equal(
      formatMutationError({ code: "DEPENDENCY_DELETED", depId: 99 }),
      "Error: dependency #99 is deleted (cannot be a dependency)",
    );
    assert.equal(
      formatMutationError({ code: "DEPENDENCY_SELF", depId: 17 }),
      "Error: #17 cannot block on itself",
    );
    assert.equal(
      formatMutationError({ code: "DEPENDENCY_CYCLE", attempted: [17, 18] }),
      "Error: would create a dependency cycle via [17, 18]",
    );
    assert.equal(
      formatMutationError({
        code: "INVALID_TRANSITION",
        from: "completed",
        to: "in_progress",
      }),
      "Error: illegal transition completed → in_progress",
    );
    assert.equal(
      formatMutationError({ code: "TOMBSTONE_IMMUTABLE", id: 17 }),
      "Error: #17 is deleted (tombstones are immutable)",
    );
    assert.equal(
      formatMutationError({ code: "ALREADY_DELETED", id: 17 }),
      "Error: #17 is already deleted",
    );
    assert.match(
      formatMutationError({ code: "MUTABLE_FIELDS_REQUIRED" }),
      /^Error: update requires at least one mutable field/,
    );
  });

  it("exhaustiveness: every MutationError code has a format case", () => {
    // Static check lives in format.ts (the `default` clause's `never`
    // assertion). This test just documents the contract: callers can
    // pass any MutationError variant and always get a string back.
    const samples: MutationError[] = [
      { code: "SUBJECT_REQUIRED" },
      { code: "ID_REQUIRED" },
      { code: "TASK_NOT_FOUND", id: 1 },
      { code: "DEPENDENCY_NOT_FOUND", depId: 1 },
      { code: "DEPENDENCY_DELETED", depId: 1 },
      { code: "DEPENDENCY_SELF", depId: 1 },
      { code: "DEPENDENCY_CYCLE", attempted: [1] },
      { code: "INVALID_TRANSITION", from: "pending", to: "completed" },
      { code: "TOMBSTONE_IMMUTABLE", id: 1 },
      { code: "ALREADY_DELETED", id: 1 },
      { code: "MUTABLE_FIELDS_REQUIRED" },
      { code: "UNKNOWN_ACTION", action: "x" },
    ];
    for (const s of samples) {
      assert.match(formatMutationError(s), /^Error:/);
    }
  });
});

// ── P0-A2.3 — Lifecycle mutations: start / finish / reopen ───────────

describe("start", () => {
  it("pending → in_progress: success with op.kind start", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "parser",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(999),
    );
    if (r.op.kind === "start") {
      assert.equal(r.op.id, 17);
      assert.equal(r.op.fromStatus, "pending");
      assert.equal(r.op.toStatus, "in_progress");
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "in_progress");
      assert.equal(t?.updatedAt, 999);
      assert.equal(t?.createdAt, 100);
    } else {
      assert.fail(`expected start op, got ${r.op.kind}`);
    }
  });

  it("in_progress → start: INVALID_TRANSITION, state unchanged", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "in_progress",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
      if (r.op.error.code === "INVALID_TRANSITION") {
        assert.equal(r.op.error.from, "in_progress");
        assert.equal(r.op.error.to, "in_progress");
      }
    }
    assert.equal(r.state.tasks[0]?.status, "in_progress");
    assert.equal(r.state.tasks[0]?.updatedAt, 200);
  });

  it("completed → start: INVALID_TRANSITION", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
    }
  });

  it("deleted → start: INVALID_TRANSITION (tombstone immutable)", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "deleted" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
    }
  });

  it("missing task → TASK_NOT_FOUND", () => {
    const r = applyTaskMutation(
      mkState(),
      { action: "start", id: 999 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TASK_NOT_FOUND");
      if (r.op.error.code === "TASK_NOT_FOUND") {
        assert.equal(r.op.error.id, 999);
      }
    }
  });

  it("no id → ID_REQUIRED", () => {
    const r = applyTaskMutation(mkState(), { action: "start" }, fixedCtx(999));
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ID_REQUIRED");
    }
  });

  it("preserves existing activeForm (does not clear)", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        activeForm: "Implementing x",
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(1000),
    );
    if (r.op.kind === "start") {
      assert.equal(r.state.tasks[0]?.activeForm, "Implementing x");
    } else {
      assert.fail(`expected start op`);
    }
  });

  it("missing activeForm does not prevent start", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "pending" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(1000),
    );
    assert.equal(r.op.kind, "start");
    if (r.op.kind === "start") {
      assert.equal(r.state.tasks[0]?.activeForm, undefined);
    }
  });

  it("preserves blockedBy / description / metadata / owner", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        blockedBy: [3],
        description: "long",
        owner: "agent",
        metadata: { key: "v" },
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(1000),
    );
    if (r.op.kind === "start") {
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.deepEqual(t?.blockedBy, [3]);
      assert.equal(t?.description, "long");
      assert.equal(t?.owner, "agent");
      assert.deepEqual(t?.metadata, { key: "v" });
    } else {
      assert.fail(`expected start op`);
    }
  });

  it("atomicity: rejected start leaves state byte-equivalent (deep equal)", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "start", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    // Deep-equal: no field changed, no timestamp bumped.
    assert.equal(JSON.stringify(r.state), JSON.stringify(state));
  });
});

describe("finish", () => {
  it("in_progress → completed: success", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "parser",
        status: "in_progress",
        createdAt: 100,
        updatedAt: 200,
        activeForm: "Implementing",
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(999),
    );
    if (r.op.kind === "finish") {
      assert.equal(r.op.id, 17);
      assert.equal(r.op.fromStatus, "in_progress");
      assert.equal(r.op.toStatus, "completed");
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "completed");
      assert.equal(t?.updatedAt, 999);
      assert.equal(t?.createdAt, 100);
      assert.equal(t?.activeForm, "Implementing"); // preserved
    } else {
      assert.fail(`expected finish op, got ${r.op.kind}`);
    }
  });

  it("pending → finish: INVALID_TRANSITION", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "pending" }));
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
      if (r.op.error.code === "INVALID_TRANSITION") {
        assert.equal(r.op.error.from, "pending");
        assert.equal(r.op.error.to, "completed");
      }
    }
  });

  it("completed → finish: INVALID_TRANSITION (use reopen first)", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "completed" }));
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
    }
  });

  it("deleted → finish: INVALID_TRANSITION (tombstone)", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "deleted" }));
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
  });

  it("missing task → TASK_NOT_FOUND", () => {
    const r = applyTaskMutation(
      mkState(),
      { action: "finish", id: 999 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TASK_NOT_FOUND");
    }
  });

  it("no id → ID_REQUIRED", () => {
    const r = applyTaskMutation(mkState(), { action: "finish" }, fixedCtx(999));
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ID_REQUIRED");
    }
  });

  it("★ does NOT mutate dependents (no projection work in reducer)", () => {
    // The reducer only changes #17's status. Dependents (#18, #19) keep
    // their status. Any "Now ready: ◆ #18" comes from the P1 formatter
    // computing projection(prev) − projection(next), not from reducer.
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "in_progress" }),
      taskWithTimestamps({ id: 18, subject: "y", status: "pending" }),
      taskWithTimestamps({ id: 19, subject: "z", status: "pending" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "finish");
    // Dependents unchanged
    assert.equal(r.state.tasks[1]?.status, "pending");
    assert.equal(r.state.tasks[2]?.status, "pending");
    // #18 and #19 updatedAt NOT bumped (no spillover)
    assert.equal(r.state.tasks[1]?.updatedAt, 0);
    assert.equal(r.state.tasks[2]?.updatedAt, 0);
  });

  it("atomicity: rejected finish leaves state byte-equivalent", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(JSON.stringify(r.state), JSON.stringify(state));
  });

  it("preserves activeForm across finish", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        status: "in_progress",
        activeForm: "finishing x",
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "finish", id: 17 },
      fixedCtx(1000),
    );
    if (r.op.kind === "finish") {
      assert.equal(r.state.tasks[0]?.activeForm, "finishing x");
    } else {
      assert.fail("expected finish");
    }
  });
});

describe("reopen", () => {
  it("completed → pending: success", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "parser",
        status: "completed",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    if (r.op.kind === "reopen") {
      assert.equal(r.op.id, 17);
      assert.equal(r.op.fromStatus, "completed");
      assert.equal(r.op.toStatus, "pending");
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "pending");
      assert.equal(t?.updatedAt, 999);
      assert.equal(t?.createdAt, 100);
    } else {
      assert.fail(`expected reopen op, got ${r.op.kind}`);
    }
  });

  it("pending → reopen: INVALID_TRANSITION", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "pending" }));
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
    }
  });

  it("in_progress → reopen: INVALID_TRANSITION", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "in_progress" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "INVALID_TRANSITION");
      if (r.op.error.code === "INVALID_TRANSITION") {
        assert.equal(r.op.error.from, "in_progress");
        assert.equal(r.op.error.to, "pending");
      }
    }
  });

  it("deleted → reopen: INVALID_TRANSITION (tombstone)", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "deleted" }));
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
  });

  it("missing task → TASK_NOT_FOUND", () => {
    const r = applyTaskMutation(
      mkState(),
      { action: "reopen", id: 999 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TASK_NOT_FOUND");
    }
  });

  it("no id → ID_REQUIRED", () => {
    const r = applyTaskMutation(mkState(), { action: "reopen" }, fixedCtx(999));
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ID_REQUIRED");
    }
  });

  it("★ does NOT mutate dependents (no domain write to downstream tasks)", () => {
    // The CRITICAL test: reopen changes ONLY #17's status. #18 keeps
    // its `pending` status — even though projection will now show it as
    // BLOCKED (because its dependency #17 is no longer completed).
    // Lifecycle mutation MUST NOT touch downstream state.
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({
        id: 18,
        subject: "y",
        status: "pending",
        blockedBy: [17],
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    if (r.op.kind === "reopen") {
      // #17 status flipped
      assert.equal(r.state.tasks[0]?.status, "pending");
      // #18 status unchanged
      assert.equal(r.state.tasks[1]?.status, "pending");
      // #18 updatedAt NOT bumped
      assert.equal(r.state.tasks[1]?.updatedAt, 0);
    } else {
      assert.fail(`expected reopen op`);
    }
  });

  it("★ integration: reopen flips projection via graph, NOT via reducer write", () => {
    // Before reopen: #17 completed; #18 blockedBy [17]; deps satisfied.
    // After reopen:  #17 pending;    #18 blockedBy [17] (unchanged);
    //                dependenciesSatisfied(#18) flips true → false.
    //                BUT #18.status remains "pending" (no domain write).
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({
        id: 18,
        subject: "y",
        status: "pending",
        blockedBy: [17],
      }),
    );
    // Sanity: pre-reopen, #18's deps are satisfied.
    assert.equal(dependenciesSatisfied(state, 18), true);

    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    if (r.op.kind !== "reopen") {
      assert.fail("expected reopen op");
      return;
    }
    // #18.status STILL pending — lifecycle didn't touch it.
    assert.equal(r.state.tasks[1]?.status, "pending");
    // But dependenciesSatisfied now flips via graph:
    assert.equal(dependenciesSatisfied(r.state, 18), false);
    // This is exactly the layer-purity proof:
    //   - Reducer: domain mutation, status changes only on the targeted task.
    //   - Graph: derives projection state from raw status + blockedBy.
    //   - The "READY → BLOCKED" flip is computed by graph, not by reducer.
  });

  it("atomicity: rejected reopen leaves state byte-equivalent", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    assert.equal(JSON.stringify(r.state), JSON.stringify(state));
  });

  it("preserves activeForm across reopen", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        status: "completed",
        activeForm: "finishing x",
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(1000),
    );
    if (r.op.kind === "reopen") {
      assert.equal(r.state.tasks[0]?.activeForm, "finishing x");
    } else {
      assert.fail("expected reopen");
    }
  });

  it("preserves blockedBy / description / metadata / owner", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        blockedBy: [3],
        description: "long",
        owner: "agent",
        metadata: { key: "v" },
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(1000),
    );
    if (r.op.kind === "reopen") {
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.deepEqual(t?.blockedBy, [3]);
      assert.equal(t?.description, "long");
      assert.equal(t?.owner, "agent");
      assert.deepEqual(t?.metadata, { key: "v" });
    } else {
      assert.fail("expected reopen");
    }
  });
});

// ── P0-A2.4 — Visibility (archive/restore) + delete reverse-dep guard ─

describe("archive", () => {
  it("single completed → archived: archivedAt set, status unchanged", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        createdAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17] },
      fixedCtx(999),
    );
    if (r.op.kind === "archive") {
      assert.deepEqual(r.op.ids, [17]);
      assert.equal(r.op.count, 1);
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "completed"); // unchanged
      assert.equal(t?.archivedAt, 999);
      assert.equal(t?.updatedAt, 999);
      assert.equal(t?.createdAt, 100); // unchanged
    } else {
      assert.fail(`expected archive op, got ${r.op.kind}`);
    }
  });

  it("batch completed → all archived", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "completed" }),
      taskWithTimestamps({ id: 18, status: "completed" }),
      taskWithTimestamps({ id: 19, status: "completed" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17, 18, 19] },
      fixedCtx(999),
    );
    if (r.op.kind === "archive") {
      assert.equal(r.op.count, 3);
      assert.equal(r.state.tasks[0]?.archivedAt, 999);
      assert.equal(r.state.tasks[1]?.archivedAt, 999);
      assert.equal(r.state.tasks[2]?.archivedAt, 999);
    } else {
      assert.fail("expected archive");
    }
  });

  it("★ batch atomicity: completed + completed + pending → NONE changed", () => {
    // P0-A2.4 invariant: validate ALL first, commit NONE if any fails.
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "completed" }),
      taskWithTimestamps({ id: 18, status: "completed" }),
      taskWithTimestamps({ id: 19, status: "pending" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17, 18, 19] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ARCHIVE_REQUIRES_COMPLETED");
      if (r.op.error.code === "ARCHIVE_REQUIRES_COMPLETED") {
        assert.equal(r.op.error.id, 19);
      }
    }
    // CRITICAL: no partial success — #17 and #18 still NOT archived.
    assert.equal(r.state.tasks[0]?.archivedAt, undefined);
    assert.equal(r.state.tasks[1]?.archivedAt, undefined);
    assert.equal(r.state.tasks[2]?.archivedAt, undefined);
    // Deep-equal state.
    assert.equal(JSON.stringify(r.state), JSON.stringify(state));
  });

  it("already archived → ALREADY_ARCHIVED, no timestamp bump", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        archivedAt: 500, // already archived
        updatedAt: 500,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ALREADY_ARCHIVED");
    }
    // archivedAt + updatedAt unchanged on rejection.
    assert.equal(r.state.tasks[0]?.archivedAt, 500);
    assert.equal(r.state.tasks[0]?.updatedAt, 500);
  });

  it("pending status → ARCHIVE_REQUIRES_COMPLETED", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "pending" }));
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ARCHIVE_REQUIRES_COMPLETED");
    }
  });

  it("in_progress status → ARCHIVE_REQUIRES_COMPLETED", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "in_progress" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "ARCHIVE_REQUIRES_COMPLETED");
    }
  });

  it("deleted → TOMBSTONE_IMMUTABLE", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "deleted" }));
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TOMBSTONE_IMMUTABLE");
    }
  });

  it("missing id → TASK_NOT_FOUND", () => {
    const state = mkState(taskWithTimestamps({ id: 17, status: "completed" }));
    const r = applyTaskMutation(
      state,
      { action: "archive", ids: [17, 999] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TASK_NOT_FOUND");
      if (r.op.error.code === "TASK_NOT_FOUND") {
        assert.equal(r.op.error.id, 999);
      }
    }
    // #17 not archived due to atomicity.
    assert.equal(r.state.tasks[0]?.archivedAt, undefined);
  });

  it("empty ids → no-op success (count 0)", () => {
    const r = applyTaskMutation(
      mkState(taskWithTimestamps({ id: 17, status: "completed" })),
      { action: "archive", ids: [] },
      fixedCtx(999),
    );
    if (r.op.kind === "archive") {
      assert.equal(r.op.count, 0);
      assert.deepEqual(r.op.ids, []);
    } else {
      assert.fail("expected archive no-op");
    }
  });
});

describe("restore", () => {
  it("single archived → restored: archivedAt cleared, status unchanged", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        archivedAt: 500,
        updatedAt: 500,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17] },
      fixedCtx(999),
    );
    if (r.op.kind === "restore") {
      assert.deepEqual(r.op.ids, [17]);
      assert.equal(r.op.count, 1);
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "completed"); // unchanged
      assert.equal(t?.archivedAt, undefined); // cleared
      assert.equal(t?.updatedAt, 999);
    } else {
      assert.fail(`expected restore op, got ${r.op.kind}`);
    }
  });

  it("batch archived → all restored", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "completed", archivedAt: 100 }),
      taskWithTimestamps({ id: 18, status: "completed", archivedAt: 200 }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17, 18] },
      fixedCtx(999),
    );
    if (r.op.kind === "restore") {
      assert.equal(r.op.count, 2);
      assert.equal(r.state.tasks[0]?.archivedAt, undefined);
      assert.equal(r.state.tasks[1]?.archivedAt, undefined);
    } else {
      assert.fail("expected restore");
    }
  });

  it("★ batch atomicity: archived + not-archived → NONE changed", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "completed", archivedAt: 100 }),
      taskWithTimestamps({ id: 18, status: "completed" }), // not archived
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17, 18] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "NOT_ARCHIVED");
      if (r.op.error.code === "NOT_ARCHIVED") {
        assert.equal(r.op.error.id, 18);
      }
    }
    // #17 still archived (no partial success).
    assert.equal(r.state.tasks[0]?.archivedAt, 100);
    assert.equal(r.state.tasks[1]?.archivedAt, undefined);
  });

  it("not archived → NOT_ARCHIVED, timestamp unchanged", () => {
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "NOT_ARCHIVED");
    }
    assert.equal(r.state.tasks[0]?.updatedAt, 200);
  });

  it("★ deleted + archived → TOMBSTONE_IMMUTABLE (deleted is terminal)", () => {
    // Even if a legacy snapshot has weird state, restore must not undo
    // a tombstone. This is the "restore must not imply undelete" rule.
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "deleted",
        archivedAt: 100, // weird but legal legacy state
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TOMBSTONE_IMMUTABLE");
    }
  });

  it("missing id → TASK_NOT_FOUND, no change to existing archived", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "completed", archivedAt: 100 }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17, 999] },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    // #17 still archived due to atomicity.
    assert.equal(r.state.tasks[0]?.archivedAt, 100);
  });

  it("empty ids → no-op success", () => {
    const r = applyTaskMutation(
      mkState(),
      { action: "restore", ids: [] },
      fixedCtx(999),
    );
    if (r.op.kind === "restore") {
      assert.equal(r.op.count, 0);
    } else {
      assert.fail("expected restore no-op");
    }
  });

  it("★ status preserved across restore: completed stays completed", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, status: "completed", archivedAt: 100 }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17] },
      fixedCtx(999),
    );
    if (r.op.kind === "restore") {
      assert.equal(r.state.tasks[0]?.status, "completed");
    } else {
      assert.fail("expected restore");
    }
  });
});

describe("delete with reverse-dep guard (A2.4)", () => {
  it("★ has non-deleted reverse dep → TASK_REFERENCED", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({
        id: 18,
        subject: "y",
        status: "pending",
        blockedBy: [17],
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TASK_REFERENCED");
      if (r.op.error.code === "TASK_REFERENCED") {
        assert.equal(r.op.error.id, 17);
        assert.deepEqual(r.op.error.referencedBy, [18]);
      }
    }
    // #17 not deleted.
    assert.equal(r.state.tasks[0]?.status, "completed");
  });

  it("★ only deleted reverse dep → allowed (deleted doesn't block)", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({
        id: 18,
        subject: "y",
        status: "deleted",
        blockedBy: [17],
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    // No reverse-dep block (the only dep is from a tombstone).
    assert.equal(r.op.kind, "delete");
    if (r.op.kind === "delete") {
      assert.equal(r.state.tasks[0]?.status, "deleted");
    }
  });

  it("★ archived reverse dep STILL blocks delete (visibility \u2260 lineage)", () => {
    // archivedAt does NOT participate in referential integrity.
    // Even if #18 is hidden, it still references #17 \u2014 delete must fail.
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({
        id: 18,
        subject: "y",
        status: "completed",
        archivedAt: 500, // hidden but references #17
        blockedBy: [17],
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error") {
      assert.equal(r.op.error.code, "TASK_REFERENCED");
      if (r.op.error.code === "TASK_REFERENCED") {
        assert.deepEqual(r.op.error.referencedBy, [18]);
      }
    }
  });

  it("no reverse deps → delete succeeds (existing behavior)", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "delete");
    if (r.op.kind === "delete") {
      assert.equal(r.state.tasks[0]?.status, "deleted");
    }
  });

  it("multiple reverse deps: all listed in referencedBy", () => {
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({ id: 18, subject: "y", blockedBy: [17] }),
      taskWithTimestamps({ id: 19, subject: "z", blockedBy: [17] }),
      taskWithTimestamps({ id: 20, subject: "w", blockedBy: [17] }),
    );
    const r = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r.op.kind, "error");
    if (r.op.kind === "error" && r.op.error.code === "TASK_REFERENCED") {
      assert.deepEqual(r.op.error.referencedBy, [18, 19, 20]);
    }
  });
});

// ── A2.4 cross-mutation integration (the most important tests) ───────────

describe("A2.4 cross-mutation integration", () => {
  it("\u2605 archived completed + reopen \u2192 pending + archived (no auto-restore)", () => {
    // Core principle: reopen and restore are orthogonal.
    //   reopen: status lifecycle (completed \u2192 pending), ignores archivedAt
    //   restore: visibility (archivedAt = undefined), ignores status
    // reopen on an archived task flips status but leaves archivedAt
    // intact. Resulting state (pending + archived) is legal and is the
    // projection's responsibility to handle, NOT the reducer's.
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "completed",
        archivedAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "reopen", id: 17 },
      fixedCtx(999),
    );
    if (r.op.kind === "reopen") {
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "pending");
      assert.equal(t?.archivedAt, 100); // NOT cleared
      assert.equal(t?.updatedAt, 999);
    } else {
      assert.fail("expected reopen");
    }
  });

  it("\u2605 pending + archived + restore \u2192 pending + visible (status preserved)", () => {
    // After the previous scenario, the user does restore. Restore is
    // status-agnostic: it only clears archivedAt. Status stays pending.
    const state = mkState(
      taskWithTimestamps({
        id: 17,
        subject: "x",
        status: "pending",
        archivedAt: 100,
        updatedAt: 200,
      }),
    );
    const r = applyTaskMutation(
      state,
      { action: "restore", ids: [17] },
      fixedCtx(999),
    );
    if (r.op.kind === "restore") {
      const t = r.state.tasks[0];
      assert.ok(t);
      assert.equal(t?.status, "pending"); // preserved
      assert.equal(t?.archivedAt, undefined);
    } else {
      assert.fail("expected restore");
    }
  });

  it("★ delete referenced task → must archive OR fix deps first", () => {
    // Real workflow: #17 completed, #18 blockedBy [17]. User wants to
    // delete #17 but it has a live reverse dep. Reducer enforces
    // referential integrity; CLI/Tool layer (P1) suggests archive or
    // remove dep. Reducer is pure — state chains through results.
    const state = mkState(
      taskWithTimestamps({ id: 17, subject: "x", status: "completed" }),
      taskWithTimestamps({
        id: 18,
        subject: "y",
        status: "pending",
        blockedBy: [17],
      }),
    );
    const r1 = applyTaskMutation(
      state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r1.op.kind, "error");
    if (r1.op.kind === "error") {
      assert.equal(r1.op.error.code, "TASK_REFERENCED");
    }
    // After removing the dep (using r1.state — reducer is pure, no side effects):
    const r2 = applyTaskMutation(
      r1.state,
      { action: "update", id: 18, removeBlockedBy: [17] },
      fixedCtx(999),
    );
    assert.equal(r2.op.kind, "update");
    // Now delete should succeed (no more reverse deps):
    const r3 = applyTaskMutation(
      r2.state,
      { action: "delete", id: 17 },
      fixedCtx(999),
    );
    assert.equal(r3.op.kind, "delete");
  });
});
