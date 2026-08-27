/**
 * Pure task-state reducer: (state, action, params) → { state, op }.
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
 *     are rejected with specific messages.
 */

import type {
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
  | { kind: "error"; message: string };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
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

/** Would adding these edges to `from` create a cycle? DFS from `from`. */
function wouldCycle(tasks: readonly Task[], from: number, nextBlockedBy: number[]): boolean {
  const adj = new Map<number, number[]>();
  for (const t of tasks) adj.set(t.id, t.id === from ? nextBlockedBy : (t.blockedBy ?? []));
  const seen = new Set<number>();
  const stack = [...nextBlockedBy];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(adj.get(cur) ?? []));
  }
  return false;
}

function validateDeps(
  state: TaskState,
  deps: number[],
  label: string,
): string | null {
  for (const dep of deps) {
    const depTask = state.tasks.find((t) => t.id === dep);
    if (!depTask) return `${label}: #${dep} not found`;
    if (depTask.status === "deleted") return `${label}: #${dep} is deleted`;
  }
  return null;
}

export function applyTaskMutation(
  state: TaskState,
  action: TaskAction,
  params: TaskMutationParams,
): ApplyResult {
  switch (action) {
    case "create": {
      if (typeof params.subject !== "string" || !params.subject.trim()) {
        return errorResult(state, "subject required for create");
      }
      if (params.blockedBy?.length) {
        const err = validateDeps(state, params.blockedBy, "blockedBy");
        if (err) return errorResult(state, err);
      }
      const task: Task = { id: state.nextId, subject: params.subject, status: "pending" };
      if (typeof params.description === "string") task.description = params.description;
      if (typeof params.activeForm === "string") task.activeForm = params.activeForm;
      if (params.blockedBy?.length) task.blockedBy = [...params.blockedBy];
      if (typeof params.owner === "string") task.owner = params.owner;
      if (params.metadata) task.metadata = { ...params.metadata };
      return {
        state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
        op: { kind: "create", taskId: task.id },
      };
    }

    case "update": {
      if (params.id === undefined) return errorResult(state, "id required for update");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];

      // Tombstone immutability: deleted tasks accept no further edits.
      if (current.status === "deleted") {
        return errorResult(state, `#${current.id} is deleted (tombstones are immutable)`);
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
        return errorResult(
          state,
          "update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, removeBlockedBy",
        );
      }

      // Explicit TaskStatus: the tombstone guard above narrows
      // current.status to non-deleted, but params.status may legally be
      // "deleted" (the completed → deleted transition).
      let newStatus: TaskStatus = current.status;
      if (params.status !== undefined) {
        if (!isTransitionValid(current.status, params.status)) {
          return errorResult(
            state,
            `illegal transition ${current.status} → ${params.status}`,
          );
        }
        newStatus = params.status;
      }

      let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
      if (params.removeBlockedBy?.length) {
        const drop = new Set(params.removeBlockedBy);
        newBlockedBy = newBlockedBy.filter((id) => !drop.has(id));
      }
      if (params.addBlockedBy?.length) {
        const err = validateDeps(state, params.addBlockedBy, "addBlockedBy");
        if (err) return errorResult(state, err);
        for (const dep of params.addBlockedBy) {
          if (dep === current.id) {
            return errorResult(state, `cannot block #${current.id} on itself`);
          }
          if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
        }
        if (wouldCycle(state.tasks, current.id, newBlockedBy)) {
          return errorResult(state, "addBlockedBy would create a dependency cycle");
        }
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
      if (params.description !== undefined) updated.description = params.description;
      if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
      if (params.owner !== undefined) updated.owner = params.owner;
      if (newBlockedBy.length > 0) updated.blockedBy = newBlockedBy;
      else delete updated.blockedBy;
      if (newMetadata === undefined) delete updated.metadata;
      else updated.metadata = newMetadata;

      const tasks = [...state.tasks];
      tasks[idx] = updated;
      return {
        state: { tasks, nextId: state.nextId },
        op: {
          kind: "update",
          id: updated.id,
          fromStatus: current.status,
          toStatus: newStatus,
          changed: taskChanged(current, updated),
        },
      };
    }

    case "list": {
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status === undefined ? {} : { statusFilter: params.status }),
        },
      };
    }

    case "get": {
      if (params.id === undefined) return errorResult(state, "id required for get");
      const task = state.tasks.find((t) => t.id === params.id);
      if (!task) return errorResult(state, `#${params.id} not found`);
      return { state, op: { kind: "get", task } };
    }

    case "delete": {
      if (params.id === undefined) return errorResult(state, "id required for delete");
      const idx = state.tasks.findIndex((t) => t.id === params.id);
      if (idx === -1) return errorResult(state, `#${params.id} not found`);
      const current = state.tasks[idx];
      if (current.status === "deleted") {
        return errorResult(state, `#${current.id} is already deleted`);
      }
      const tasks = [...state.tasks];
      tasks[idx] = { ...current, status: "deleted" };
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
    default: {
      // Exhaustiveness guard: a new TaskAction without a case fails here.
      const _exhaustive: never = action;
      return errorResult(state, `unknown action: ${String(_exhaustive)}`);
    }
  }
}
