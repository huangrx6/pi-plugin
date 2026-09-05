/**
 * projection.ts — pure view layer for the active work surface.
 *
 * Module invariants (P0-B / B1 LOCKED):
 *   1. PURE READ: no state mutation, no clock access, no pi imports.
 *   2. archivedAt !== undefined → task NEVER appears in any active
 *      projection (running/ready/blocked). Pending + archived is a
 *      legal A2.4 state but invisible to the active view. The
 *      caller (overlay, /todos read) decides whether to also show
 *      archived tasks via projectArchived.
 *   3. status === "deleted" → task NEVER appears in any active
 *      projection. Tombstones are diagnostics-only (/todos deleted,
 *      not yet implemented in P0-B).
 *   4. status === "completed" → task NEVER appears in active
 *      projection. Goes to projectCompleted instead.
 *   5. classifyTask is the SINGLE source of truth for "which tasks
 *      have an active role". projectActiveView iterates and calls it
 *      — no separate archived/deleted/completed filter duplicated at
 *      the call site. This means if the visibility rule ever changes,
 *      there's one place to update.
 *   6. NEVER references mutation concepts (Op, MutationError, ctx.now,
 *      ReducerContext). Reads from graph.ts (domain semantics) and
 *      TaskState (raw state) only. Different layer, different vocabulary.
 *   7. Sort comparators always end with `a.id - b.id` as deterministic
 *      tie-breaker — legacy tasks all have createdAt=0, so the explicit
 *      id-asc final step makes the contract stable across JS engines.
 *
 * Reads graph.ts (wouldCreateCycle, etc.) but graph.ts NEVER imports
 * projection.ts. The dependency direction is one-way:
 *   projection.ts → graph.ts → types.ts
 */

import {
 brokenDependencies,
 dependenciesSatisfied,
 unsatisfiedDependencies,
} from "./graph.ts";
import type {
 ActiveClassification,
 ActiveView,
 ActiveViewDiff,
 Task,
 TaskId,
 TaskState,
} from "./types.ts";

// ── classifyTask ─────────────────────────────────────────────────────────

/**
 * Single task's role in the active work surface, OR `undefined` if the
 * task has no active role.
 *
 * Returns:
 *   - "running" — in_progress (must NOT be archived; archived returns undefined)
 *   - "ready"   — pending, all deps satisfied, NOT archived
 *   - "blocked" — pending, has unsatisfied or broken deps, NOT archived
 *   - undefined — archived OR deleted OR completed (no active role)
 *
 * Defensive design: archived/deleted/completed are all rejected with
 * `undefined` rather than mapped to a sentinel like "blocked". This
 * makes the "no active role" case explicit at the type level (caller
 * can pattern-match `undefined` and skip cleanly), and prevents
 * silent misclassification if classifyTask is accidentally called on
 * a task that shouldn't be in the active set.
 */
export function classifyTask(
 state: TaskState,
 task: Task,
): ActiveClassification | undefined {
 // Visibility FIRST: archived overrides status. (See invariant #2.)
 if (task.archivedAt !== undefined) return undefined;
 if (task.closedAt !== undefined) return undefined;
 // Tombstone: deleted is terminal, no active role.
 if (task.status === "deleted") return undefined;
 // Completed: not active; lives in projectCompleted instead.
 if (task.status === "completed") return undefined;

 if (task.status === "in_progress") return "running";
 if (task.status === "pending") {
  return dependenciesSatisfied(state, task.id) ? "ready" : "blocked";
 }
 // Exhaustiveness: any new status without a case falls through.
 return undefined;
}

// ── Sort comparators (deterministic; id-asc final tie-breaker) ──────────

function compareRunning(a: Task, b: Task): number {
 // updatedAt desc (most recently active first)
 if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
 // Deterministic tie-breaker
 return a.id - b.id;
}

function compareReady(a: Task, b: Task): number {
 // createdAt asc (oldest ready first; don't starve old work)
 if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
 return a.id - b.id;
}

function compareBlocked(state: TaskState): (a: Task, b: Task) => number {
 // BLOCKED sort: broken first → unsatisfied direct count asc → createdAt asc → id asc
 return (a, b) => {
  // 1. broken first (tasks with missing/deleted refs need manual triage)
  const aBroken = brokenDependencies(state, a.id).length > 0;
  const bBroken = brokenDependencies(state, b.id).length > 0;
  if (aBroken !== bBroken) return aBroken ? -1 : 1;
  // 2. unsatisfied direct dep count asc (closer to ready = higher priority)
  const aCount = unsatisfiedDependencies(state, a.id).length;
  const bCount = unsatisfiedDependencies(state, b.id).length;
  if (aCount !== bCount) return aCount - bCount;
  // 3. createdAt asc
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  // 4. deterministic tie-breaker
  return a.id - b.id;
 };
}

function compareCompleted(a: Task, b: Task): number {
 // updatedAt desc (most recently completed first)
 if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
 return a.id - b.id;
}

function compareArchived(a: Task, b: Task): number {
 // archivedAt desc (most recently archived first)
 const aAt = a.archivedAt ?? 0;
 const bAt = b.archivedAt ?? 0;
 if (aAt !== bAt) return bAt - aAt;
 return a.id - b.id;
}

function compareAll(a: Task, b: Task): number {
 // createdAt asc (insertion order)
 if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
 return a.id - b.id;
}

// ── projectActiveView ────────────────────────────────────────────────────

/**
 * Full active view: the overlay's primary input and /todos read's
 * primary input. Single source of truth: classifyTask. No separate
 * filter at the call site (per invariant #5).
 */
export function projectActiveView(state: TaskState): ActiveView {
 const running: Task[] = [];
 const ready: Task[] = [];
 const blocked: Task[] = [];

 for (const task of state.tasks) {
  const classification = classifyTask(state, task);
  if (classification === undefined) continue;
  if (classification === "running") running.push(task);
  else if (classification === "ready") ready.push(task);
  else if (classification === "blocked") blocked.push(task);
 }

 running.sort(compareRunning);
 ready.sort(compareReady);
 blocked.sort(compareBlocked(state));

 // counts.completedVisible: completed AND NOT archived.
 // Separate from the bucket loop because completed goes to
 // projectCompleted, not here.
 let completedVisible = 0;
 for (const task of state.tasks) {
  if (task.status === "completed" && task.archivedAt === undefined) {
   completedVisible++;
  }
 }

 return {
  running,
  ready,
  blocked,
  counts: {
   active: running.length + ready.length + blocked.length,
   completedVisible,
  },
 };
}

// ── projectCompleted ─────────────────────────────────────────────────────

/** Tasks completed but NOT archived. /todos completed and overlay ✓N. */
export function projectCompleted(state: TaskState): Task[] {
 const out: Task[] = [];
 for (const task of state.tasks) {
  if (task.status === "completed" && task.archivedAt === undefined) {
   out.push(task);
  }
 }
 out.sort(compareCompleted);
 return out;
}

/** Tasks intentionally ended without asserting completion. */
export function projectClosed(state: TaskState): Task[] {
 const out: Task[] = [];
 for (const task of state.tasks) {
  if (task.closedAt !== undefined && task.status !== "deleted" && task.archivedAt === undefined) {
   out.push(task);
  }
 }
 out.sort(compareCompleted);
 return out;
}

// ── Pure id-only canonical queries (P1-A shared with B3) ──────────────────────
//
// STRUCTURALLY DERIVED from projectCompleted / projectArchived / projectAll.
// They MUST NOT duplicate membership/filter/sort predicates. The single-
// source guarantee is enforced by tests that pin:
//   selectXxxTaskIds(state) === projectXxx(state).map(t => t.id)
// Used by B3 read commands AND P1 mutation selector resolution so the
// two cannot drift apart silently.

export function selectCompletedTaskIds(state: TaskState): TaskId[] {
 return projectCompleted(state).map((task) => task.id);
}

export function selectArchivedTaskIds(state: TaskState): TaskId[] {
 return projectArchived(state).map((task) => task.id);
}

export function selectAllTaskIds(state: TaskState): TaskId[] {
 return projectAll(state).map((task) => task.id);
}

// ── projectArchived ──────────────────────────────────────────────────────

/**
 * Tasks with archivedAt set, regardless of status. Excludes deleted
 * tombstones (terminal marker; archive+delete isn't a normal path).
 * /todos archived.
 */
export function projectArchived(state: TaskState): Task[] {
 const out: Task[] = [];
 for (const task of state.tasks) {
  if (task.archivedAt !== undefined && task.status !== "deleted") {
   out.push(task);
  }
 }
 out.sort(compareArchived);
 return out;
}

// ── projectAll ───────────────────────────────────────────────────────────

/**
 * All non-deleted tasks (visible + archived). /todos all.
 *
 * IMPORTANT: "all" is a user projection, not raw state.tasks. Tombstones
 * are excluded (use /todos deleted for those — P0-B doesn't implement
 * that yet, but the boundary is reserved).
 *
 * Pending + archived IS included (legal A2.4 state). It just won't
 * show up in the active view (see projectActiveView).
 */
export function projectAll(state: TaskState): Task[] {
 const out: Task[] = [];
 for (const task of state.tasks) {
  if (task.status !== "deleted") {
   out.push(task);
  }
 }
 out.sort(compareAll);
 return out;
}

// ── diffActiveView ───────────────────────────────────────────────────────

/**
 * Neutral transition diff between two projections. P1 mutation formatters
 * consume this and decide what to render based on op context.
 *
 * Membership-based: subject edits do NOT cause becameReady/becameBlocked.
 * Only actual projection membership changes (status flip, dep satisfied,
 * archive, restore, delete, create) are detected.
 *
 * Scope: only becameReady / becameBlocked. becameRunning / leftReady /
 * etc. are NOT tracked here — the user said P0-B should be minimal.
 * Future expansion (when P1 formatter needs more) is straightforward:
 * add fields, update consumers, no breaking change to the active view
 * shape.
 */
export function diffActiveView(
 prevState: TaskState,
 nextState: TaskState,
): ActiveViewDiff {
 const prev = projectActiveView(prevState);
 const next = projectActiveView(nextState);
 const prevReadyIds = new Set(prev.ready.map((t) => t.id));
 const prevBlockedIds = new Set(prev.blocked.map((t) => t.id));
 return {
  becameReady: next.ready.filter((t) => !prevReadyIds.has(t.id)),
  becameBlocked: next.blocked.filter((t) => !prevBlockedIds.has(t.id)),
 };
}
