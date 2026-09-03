/**
 * Pure task-state reducer: (state, params, ctx) → { state, op }.
 * No store access, no pi imports — independently testable.
 *
 * Semantics guarded here (each closes a defect observed in the wild):
 *   - `clear` keeps `nextId` MONOTONIC: ids are never reused, so stale
 *     "#N" references in the conversation can never point at a new task.
 *   - Deleted tasks are IMMUTABLE tombstones: `update` on a deleted task
 *     is rejected (status transition deleted→deleted was legal and let
 *     subject/metadata edits bypass the tombstone).
 *   - No-op updates are detected with a key-order-INSENSITIVE metadata
 *     comparison, so a re-sent identical update reports "no change"
 *     instead of re-rendering and inviting a model retry loop.
 *   - blockedBy: dangling/deleted references, self-blocks, and cycles
 *     are rejected. ALL write paths (create, update, future deps add)
 *     go through normalizeAndValidateBlockedBy so invariants live in
 *     ONE place.
 *
 * Dependency direction:
 *   reducer.ts → graph.ts → types.ts
 *   graph.ts NEVER imports reducer (read-only). reducer.ts imports
 *   graph.wouldCreateCycle for cycle detection — mutation authority
 *   consults domain semantics before committing.
 *
 * Atomicity rule (A2.1):
 *   Validate FIRST, commit once. If any validation fails, return the
 *   first structured error and leave state as-is. updatedAt bumps ONLY
 *   on real changes — no-op updates don't refresh the timestamp.
 *
 * Error contract (A2.2):
 *   All errors are structured (MutationError) with `code` discriminator
 *   and contextual fields. Consumers (formatContent, CLI, Tool API)
 *   pattern-match on `code` instead of parsing strings.
 */

import { wouldCreateCycle, reverseDependencies } from "./graph.ts";
import type {
  BlockedByValidationResult,
  MutationError,
  ReduceContext,
  Task,
  TaskAction,
  TaskMutationParams,
  TaskState,
  TaskStatus,
} from "./types.ts";

export type Op =
  | { kind: "create"; taskId: number }
  | {
      kind: "update";
      id: number;
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
      changed: boolean;
    }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | {
      kind: "start";
      id: number;
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
    }
  | {
      kind: "finish";
      id: number;
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
    }
  | {
      kind: "reopen";
      id: number;
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
    }
  | { kind: "archive"; ids: number[]; count: number }
  | { kind: "restore"; ids: number[]; count: number }
  | { kind: "error"; error: MutationError };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

function errorResult(state: TaskState, error: MutationError): ApplyResult {
  return { state, op: { kind: "error", error } };
}

// ── Dependency invariants (P0-A2.2) ─────────────────────────────────────

/** Dedup preserving first occurrence. Domain invariant: blockedBy
 *  contains unique task ids — graph.ts functions assume uniqueness.
 *  Reducer calls this on every write path so the invariant is enforced
 *  at the source rather than relying on consumers. */
export function dedupeBlockedBy(ids: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The single validation pipeline for blockedBy writes.
 *
 * Pipeline order (locked in graph.ts dependency contract):
 *   1. dedupe preserving first occurrence
 *   2. self-loop check (depId === taskId)
 *   3. existence check (target in state.tasks)
 *   4. deleted check (target.status !== "deleted")
 *   5. cycle check via graph.wouldCreateCycle
 *
 * `undefined` / empty blockedBy → `{ ok: true, value: [] }`.
 * Returns first failure (not all) — caller commits atomically iff
 * pipeline returns ok.
 *
 * Used by create (initial blockedBy) and update (addBlockedBy merged
 * with existing). Future P2 deps add / remove / deps commands all
 * share this helper so graph correctness invariants stay centralized.
 */
export function normalizeAndValidateBlockedBy(
  state: TaskState,
  taskId: number,
  blockedBy: number[] | undefined,
): BlockedByValidationResult {
  if (!blockedBy?.length) return { ok: true, value: [] };

  // 1. Dedupe
  const deduped = dedupeBlockedBy(blockedBy);

  // 2. Self-loop
  for (const depId of deduped) {
    if (depId === taskId) {
      return {
        ok: false,
        error: { code: "DEPENDENCY_SELF", depId },
      };
    }
  }

  // 3 & 4. Existence + deleted (single pass)
  for (const depId of deduped) {
    const dep = state.tasks.find((t) => t.id === depId);
    if (!dep) {
      return {
        ok: false,
        error: { code: "DEPENDENCY_NOT_FOUND", depId },
      };
    }
    if (dep.status === "deleted") {
      return {
        ok: false,
        error: { code: "DEPENDENCY_DELETED", depId },
      };
    }
  }

  // 5. Cycle check (delegates to graph.ts — only place cycle detection lives)
  if (wouldCreateCycle(state, taskId, deduped)) {
    return {
      ok: false,
      error: { code: "DEPENDENCY_CYCLE", attempted: deduped },
    };
  }

  return { ok: true, value: deduped };
}

// ── Status transitions + change detection ──────────────────────────────────

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  // completed → pending is the `reopen` transition (added P0-A2.3).
  completed: new Set(["pending", "deleted"]),
  deleted: new Set(),
};

/** Same→same counts as valid only for non-terminal statuses. */
function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return from !== "deleted";
  return VALID_TRANSITIONS[from].has(to);
}

function sameIds(a: number[] | undefined, b: number[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Key-order-insensitive record equality (JSON.stringify is not). */
function sameRecord(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  const x = a ?? {};
  const y = b ?? {};
  const xk = Object.keys(x);
  const yk = Object.keys(y);
  if (xk.length !== yk.length) return false;
  for (const k of xk) {
    if (!Object.is(x[k], y[k])) return false;
  }
  return true;
}

function taskChanged(before: Task, after: Task): boolean {
  return (
    before.subject !== after.subject ||
    before.status !== after.status ||
    before.description !== after.description ||
    before.activeForm !== after.activeForm ||
    before.owner !== after.owner ||
    !sameIds(before.blockedBy, after.blockedBy) ||
    !sameRecord(before.metadata, after.metadata)
  );
}

// ── Main entry ───────────────────────────────────────────────────────────

/** Batch visibility mutation (archive / restore). P0-A2.4 contract:
 *  archive only operates on `completed` tasks; restore only operates on
 *  tasks that are already archived; deleted is rejected in both modes
 *  (tombstone is terminal regardless of archivedAt).
 *
 *  ATOMIC semantics: validate ALL targets first; if ANY fails, return
 *  the first error with original state (no partial success). Empty ids
 *  is a no-op success (returns count 0).
 */
function applyArchiveRestore(
  state: TaskState,
  ids: number[],
  ctx: ReduceContext,
  mode: "archive" | "restore",
): ApplyResult {
  if (ids.length === 0) {
    return { state, op: { kind: mode, ids: [], count: 0 } };
  }

  // 1. Validate ALL targets. First failure short-circuits with original state.
  const targets: { idx: number; task: Task }[] = [];
  for (const id of ids) {
    const idx = state.tasks.findIndex((t) => t.id === id);
    if (idx === -1) {
      return errorResult(state, { code: "TASK_NOT_FOUND", id });
    }
    const task = state.tasks[idx];
    if (!task) {
      return errorResult(state, { code: "TASK_NOT_FOUND", id });
    }
    if (task.status === "deleted") {
      return errorResult(state, {
        code: "TOMBSTONE_IMMUTABLE",
        id: task.id,
      });
    }
    if (mode === "archive") {
      if (task.archivedAt !== undefined) {
        return errorResult(state, {
          code: "ALREADY_ARCHIVED",
          id: task.id,
        });
      }
      if (task.status !== "completed") {
        return errorResult(state, {
          code: "ARCHIVE_REQUIRES_COMPLETED",
          id: task.id,
        });
      }
    } else {
      // restore: precondition is "must be currently archived"
      if (task.archivedAt === undefined) {
        return errorResult(state, {
          code: "NOT_ARCHIVED",
          id: task.id,
        });
      }
    }
    targets.push({ idx, task });
  }

  // 2. Commit ALL only after every target has passed validation.
  const now = ctx.now();
  const tasks = [...state.tasks];
  for (const { idx, task } of targets) {
    if (mode === "archive") {
      tasks[idx] = { ...task, archivedAt: now, updatedAt: now };
    } else {
      // restore: clear archivedAt, status untouched (status-agnostic).
      const restored: Task = { ...task, updatedAt: now };
      delete restored.archivedAt;
      tasks[idx] = restored;
    }
  }
  return {
    state: { tasks, nextId: state.nextId },
    op: {
      kind: mode,
      ids: targets.map((t) => t.task.id),
      count: targets.length,
    },
  };
}

export function applyTaskMutation(
  state: TaskState,
  params: TaskMutationParams,
  ctx: ReduceContext,
): ApplyResult {
  // params.action is typed `unknown` via the index signature; narrow it
  // back to the union so the switch exhaustiveness check still works.
  // Runtime validity is enforced upstream by TODO_PARAMS_SCHEMA.
  const action = params.action as TaskAction;
  switch (action) {
    case "create": {
      if (typeof params.subject !== "string" || !params.subject.trim()) {
        return errorResult(state, { code: "SUBJECT_REQUIRED" });
      }
      const validation = normalizeAndValidateBlockedBy(
        state,
        state.nextId,
        params.blockedBy,
      );
      if (validation.ok === false) {
        return errorResult(state, validation.error);
      }

      const now = ctx.now();
      const task: Task = {
        id: state.nextId,
        subject: params.subject,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      if (typeof params.description === "string")
        task.description = params.description;
      if (typeof params.activeForm === "string")
        task.activeForm = params.activeForm;
      if (validation.value.length > 0) task.blockedBy = validation.value;
      if (typeof params.owner === "string") task.owner = params.owner;
      if (params.metadata) task.metadata = { ...params.metadata };
      return {
        state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
        op: { kind: "create", taskId: task.id },
      };
    }

    case "update": {
      if (params.id === undefined)
        return errorResult(state, { code: "ID_REQUIRED" });
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, {
          code: "TASK_NOT_FOUND",
          id: params.id,
        });
      const current = state.tasks[idx];

      // Tombstone immutability: deleted tasks accept no further edits.
      if (current.status === "deleted") {
        return errorResult(state, {
          code: "TOMBSTONE_IMMUTABLE",
          id: current.id,
        });
      }

      const hasMutation =
        params.subject !== undefined ||
        params.description !== undefined ||
        params.activeForm !== undefined ||
        params.status !== undefined ||
        params.owner !== undefined ||
        params.metadata !== undefined ||
        (params.addBlockedBy?.length ?? 0) > 0 ||
        (params.removeBlockedBy?.length ?? 0) > 0;
      if (!hasMutation) {
        return errorResult(state, { code: "MUTABLE_FIELDS_REQUIRED" });
      }

      // Explicit TaskStatus: tombstone guard above narrows current.status
      // to non-deleted, but params.status may legally be "deleted"
      // (the completed → deleted transition).
      let newStatus: TaskStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(state, {
            code: "INVALID_TRANSITION",
            from: current.status,
            to: params.status,
          });
        }
        newStatus = params.status;
      }

      // blockedBy: apply remove first, then validate the MERGED list
      // (existing-after-remove + add) as a single write candidate.
      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      if (params.removeBlockedBy?.length) {
        const drop = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((id) => !drop.has(id));
      }
      if (params.addBlockedBy?.length) {
        const candidate = [...newBlockedBy, ...params.addBlockedBy];
        const validation = normalizeAndValidateBlockedBy(
          state,
          current.id,
          candidate,
        );
        if (validation.ok === false) {
          return errorResult(state, validation.error);
        }
        newBlockedBy = validation.value;
      }

      let newMetadata = current.metadata;
      if (params.metadata !== undefined) {
        const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
        for (const [k, v] of Object.entries(params.metadata)) {
          if (v === null) delete merged[k];
          else merged[k] = v;
        }
        newMetadata = Object.keys(merged).length > 0 ? merged : undefined;
      }

      const updated: Task = { ...current, status: newStatus };
      if (typeof params.subject === "string") updated.subject = params.subject;
      if (params.description !== undefined)
        updated.description = params.description;
      if (params.activeForm !== undefined)
        updated.activeForm = params.activeForm;
      if (params.owner !== undefined) updated.owner = params.owner;
      if (newBlockedBy.length > 0) updated.blockedBy = newBlockedBy;
      else delete updated.blockedBy;
      if (newMetadata === undefined) delete updated.metadata;
      else updated.metadata = newMetadata;

      // Atomicity rule: validate FIRST, commit once. If `changed` is
      // false (no-op), leave tasks[idx] = current so updatedAt stays
      // untouched. updatedAt is bumped only on real changes.
      const changed = taskChanged(current, updated);
      const tasks = [...state.tasks];
      if (changed) {
        tasks[idx] = { ...updated, updatedAt: ctx.now() };
      }
      // No-op: tasks[idx] still holds the original `current` object.
      return {
        state: { tasks, nextId: state.nextId },
        op: {
          kind: "update",
          id: current.id,
          fromStatus: current.status,
          toStatus: newStatus,
          changed,
        },
      };
    }

    case "list": {
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status === undefined
            ? {}
            : { statusFilter: params.status }),
        },
      };
    }

    case "get": {
      if (params.id === undefined)
        return errorResult(state, { code: "ID_REQUIRED" });
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task)
        return errorResult(state, {
          code: "TASK_NOT_FOUND",
          id: params.id,
        });
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined)
        return errorResult(state, { code: "ID_REQUIRED" });
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, {
          code: "TASK_NOT_FOUND",
          id: params.id,
        });
      const current = state.tasks[idx];
      if (current.status === "deleted") {
        return errorResult(state, {
          code: "ALREADY_DELETED",
          id: current.id,
        });
      }
      // Reverse-dep guard: any non-deleted task that references this one
      // blocks delete. archivedAt does NOT participate — archive is
      // visibility, not lineage. Restoring a hidden task would otherwise
      // find a dangling dep with no source.
      const referencedBy = reverseDependencies(state, current.id)
        .filter((t) => t.status !== "deleted")
        .map((t) => t.id);
      if (referencedBy.length > 0) {
        return errorResult(state, {
          code: "TASK_REFERENCED",
          id: current.id,
          referencedBy,
        });
      }
      const tasks = [...state.tasks];
      tasks[idx] = { ...current, status: "deleted", updatedAt: ctx.now() };
      return {
        state: { tasks, nextId: state.nextId },
        op: { kind: "delete", id: current.id, subject: current.subject },
      };
    }

    case "clear": {
      return {
        // nextId stays monotonic — see module header.
        state: { tasks: [], nextId: state.nextId },
        op: { kind: "clear", count: state.tasks.length },
      };
    }
    case "start": {
      // Lifecycle: pending → in_progress. Strict pre (status === pending)
      // — other statuses → INVALID_TRANSITION, state unchanged, updatedAt
      // untouched. activeForm preserved (or undefined) as-is.
      if (params.id === undefined)
        return errorResult(state, { code: "ID_REQUIRED" });
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, { code: "TASK_NOT_FOUND", id: params.id });
      const current = state.tasks[idx];
      if (!current || current.status !== "pending") {
        return errorResult(state, {
          code: "INVALID_TRANSITION",
          from: current?.status ?? "deleted",
          to: "in_progress",
        });
      }
      const tasks = [...state.tasks];
      tasks[idx] = { ...current, status: "in_progress", updatedAt: ctx.now() };
      return {
        state: { tasks, nextId: state.nextId },
        op: {
          kind: "start",
          id: current.id,
          fromStatus: "pending",
          toStatus: "in_progress",
        },
      };
    }
    case "finish": {
      // Lifecycle: in_progress → completed. NO downstream state mutation —
      // dependents keep their status. Any "Now ready" projection is the
      // caller's job (P1 formatter consumes projection(prev) − projection(next)).
      if (params.id === undefined)
        return errorResult(state, { code: "ID_REQUIRED" });
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, { code: "TASK_NOT_FOUND", id: params.id });
      const current = state.tasks[idx];
      if (!current || current.status !== "in_progress") {
        return errorResult(state, {
          code: "INVALID_TRANSITION",
          from: current?.status ?? "deleted",
          to: "completed",
        });
      }
      const tasks = [...state.tasks];
      tasks[idx] = { ...current, status: "completed", updatedAt: ctx.now() };
      return {
        state: { tasks, nextId: state.nextId },
        op: {
          kind: "finish",
          id: current.id,
          fromStatus: "in_progress",
          toStatus: "completed",
        },
      };
    }
    case "reopen": {
      // Lifecycle: completed → pending. NO downstream state mutation —
      // dependents keep their status. The fact that downstream may flip
      // from READY to BLOCKED is a projection concern, not a domain write.
      // Note: reopen does NOT touch archivedAt — if the task is also
      // archived (pending + archived is a legal state), it stays
      // archived. Use `restore` to bring it back to visible.
      if (params.id === undefined)
        return errorResult(state, { code: "ID_REQUIRED" });
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1)
        return errorResult(state, { code: "TASK_NOT_FOUND", id: params.id });
      const current = state.tasks[idx];
      if (!current || current.status !== "completed") {
        return errorResult(state, {
          code: "INVALID_TRANSITION",
          from: current?.status ?? "deleted",
          to: "pending",
        });
      }
      const tasks = [...state.tasks];
      tasks[idx] = { ...current, status: "pending", updatedAt: ctx.now() };
      return {
        state: { tasks, nextId: state.nextId },
        op: {
          kind: "reopen",
          id: current.id,
          fromStatus: "completed",
          toStatus: "pending",
        },
      };
    }
    case "archive": {
      // Batch: visibility OFF. P1 policy: only completed tasks are
      // archivable. ATOMIC: validate ALL targets first, commit only if
      // all are valid. Any one failure → no change anywhere.
      return applyArchiveRestore(
        state,
        (params.ids as number[] | undefined) ?? [],
        ctx,
        "archive",
      );
    }
    case "restore": {
      // Batch: visibility ON. Status-agnostic — restore only clears
      // archivedAt, leaving status untouched. ATOMIC like archive.
      return applyArchiveRestore(
        state,
        (params.ids as number[] | undefined) ?? [],
        ctx,
        "restore",
      );
    }
    default: {
      // Exhaustiveness guard: a new TaskAction without a case fails here.
      const _exhaustive: never = action;
      void _exhaustive;
      return errorResult(state, {
        code: "UNKNOWN_ACTION",
        action: "unreachable",
      });
    }
  }
}
