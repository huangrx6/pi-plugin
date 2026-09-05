/**
 * graph-query.ts — P2-A (graph query layer for read-only graph UX).
 *
 * Pure materialization: state + graph primitives → formatter-ready
 * query result. This is the ONLY P2-A path allowed to consume
 * TaskState. P2-B formatter reads the result, never inspects raw
 * state.
 *
 * Module invariants (P2-A LOCK):
 *   1. Read-only. NEVER invokes reducer / MutationPlan / mutation
 *      executor / commitState / mutation wiring.
 *   2. Imports allowed: graph.ts, projection.ts, read-model.ts,
 *      types.ts.
 *   3. No string output. UX wording belongs to P2-B formatter.
 *   4. queryNextTasks is structurally derived from
 *      projectActiveView(state).ready. Membership and ordering are
 *      inherited; no filter / sort duplication.
 *   5. Observable-state precedence (strict, top-down):
 *        deleted    → not-found
 *        archived   → archived       (even if underlying status is completed)
 *        completed  → completed
 *        running / ready / blocked  → canonical active role
 *      P2-A does NOT manufacture BLOCKED + empty-blocking states.
 *   6. For kind="blocked", blocking is exactly
 *      buildDependencyPresentation(state, id).
 *   7. queryUnlocksTask uses
 *      affectedByCompletion(state, id).newlySatisfied
 *      directly as its canonical immediate-effect membership.
 *   8. unlocks is direct / immediate effect, NEVER transitive closure.
 *   9. unlocks NEVER simulates reducer / mutation execution. Pure
 *      graph query.
 *  10. Unlock presentations preserve newlySatisfied ordering and are
 *     structurally derived with role="ready".
 *  11. P2-B NEVER re-checks archivedAt, dependency satisfaction,
 *      readiness or graph eligibility. graph.ts owns membership.
 *  12. P0/P1 remain FROZEN. This file does not import any mutation
 *      layer.
 *  13. Pure: (state, ...args) → result. No clock / no ctx / no store.
 */

import { affectedByCompletion } from "./graph.ts";
import { classifyTask, projectActiveView } from "./projection.ts";
import { buildDependencyPresentation } from "./read-model.ts";
import type {
 Task,
 TaskDependencyPresentation,
 TaskId,
 TaskState,
} from "./types.ts";

// ── Shared types ────────────────────────────────────────────────────────

/**
 * Formatter-ready task presentation. P2-local; NOT shared with P1-C's
 * MutationTargetPresentation.
 *
 * Intentionally omits `status`: formatter drives state semantics from
 * `role` (and the discriminated `kind` of the surrounding result), not
 * from raw status. Adding status back would create a second presentation
 * path the formatter could accidentally key off.
 */
export interface TaskPresentation {
 readonly id: TaskId;
 readonly subject: string;
 readonly role: TaskPresentationRole;
}

export type TaskPresentationRole =
 | "running"
 | "ready"
 | "blocked"
 | "completed"
 | "closed"
 | "archived";

// ── next ────────────────────────────────────────────────────────────────

export interface NextTasksResult {
 readonly kind: "next";
 readonly tasks: readonly TaskPresentation[];
}

/**
 * Canonical READY view, structurally derived from
 * projectActiveView(state).ready.
 */
export function queryNextTasks(state: TaskState): NextTasksResult {
 const ready = projectActiveView(state).ready;
 return {
  kind: "next",
  tasks: ready.map(toPresentation("ready")),
 };
}

// ── why ─────────────────────────────────────────────────────────────────

export type WhyTaskResult =
 | { readonly kind: "not-found"; readonly id: TaskId }
 | { readonly kind: "ready"; readonly task: TaskPresentation }
 | { readonly kind: "running"; readonly task: TaskPresentation }
 | { readonly kind: "completed"; readonly task: TaskPresentation }
 | { readonly kind: "closed"; readonly task: TaskPresentation }
 | { readonly kind: "archived"; readonly task: TaskPresentation }
 | {
    readonly kind: "blocked";
    readonly task: TaskPresentation;
    readonly blocking: readonly TaskDependencyPresentation[];
   };

/**
 * Explain the task's current observable graph state. Handles all six
 * observable states. A pending task with no current blockers is READY
 * (never BLOCKED + empty blocking).
 */
export function queryWhyTask(state: TaskState, id: TaskId): WhyTaskResult {
 const task = state.tasks.find((t) => t.id === id);
 // Precedence: missing → deleted → archived → closed → completed → active role.
 if (!task) return { kind: "not-found", id };
 if (task.status === "deleted") return { kind: "not-found", id };
 if (task.archivedAt !== undefined) {
  return { kind: "archived", task: toPresentation("archived")(task) };
 }
 if (task.closedAt !== undefined) {
  return { kind: "closed", task: toPresentation("closed")(task) };
 }
 if (task.status === "completed") {
  return { kind: "completed", task: toPresentation("completed")(task) };
 }
 // status ∈ {pending, in_progress}: classifyTask never returns undefined.
 const role = classifyTask(state, task);
 if (role === "running") {
  return { kind: "running", task: toPresentation("running")(task) };
 }
 if (role === "ready") {
  return { kind: "ready", task: toPresentation("ready")(task) };
 }
 // role === "blocked" (or undefined-defensive, which shouldn't occur here
 // because the visible-status checks above filter them out).
 return {
  kind: "blocked",
  task: toPresentation("blocked")(task),
  blocking: buildDependencyPresentation(state, id),
 };
}

// ── unlocks ─────────────────────────────────────────────────────────────

export type UnlocksTaskResult =
 | { readonly kind: "not-found"; readonly id: TaskId }
 | { readonly kind: "completed"; readonly task: TaskPresentation }
 | { readonly kind: "closed"; readonly task: TaskPresentation }
 | { readonly kind: "archived"; readonly task: TaskPresentation }
 | {
    readonly kind: "unlocks";
    readonly task: TaskPresentation;
    readonly unlocks: readonly TaskPresentation[];
   };

/**
 * Hypothetical completion effect: tasks that would become READY
 * directly because `id` is moved to completed. Does NOT simulate the
 * reducer. Uses affectedByCompletion(state, id).newlySatisfied directly.
 *
 * For BLOCKED queries, the `task.role` reflects the CURRENT role
 * (blocked), while `unlocks` is the hypothetical completion effect.
 */
export function queryUnlocksTask(
 state: TaskState,
 id: TaskId,
): UnlocksTaskResult {
 const task = state.tasks.find((t) => t.id === id);
 // Precedence: missing → deleted → archived → completed → hypothetical.
 if (!task || task.status === "deleted") {
  return { kind: "not-found", id };
 }
 if (task.archivedAt !== undefined) {
  return { kind: "archived", task: toPresentation("archived")(task) };
 }
 if (task.closedAt !== undefined) {
  return { kind: "closed", task: toPresentation("closed")(task) };
 }
 if (task.status === "completed") {
  return { kind: "completed", task: toPresentation("completed")(task) };
 }
 // status ∈ {pending, in_progress}: hypothetical completion effect.
 // C15: BLOCKED query returns current role = "blocked", not "ready".
 const currentRole = deriveCurrentRole(state, task);
 const { newlySatisfied } = affectedByCompletion(state, id);
 return {
  kind: "unlocks",
  task: toPresentation(currentRole)(task),
  unlocks: newlySatisfied.map(toPresentation("ready")),
 };
}

// ── Internal helpers ────────────────────────────────────────────────────

function toPresentation(role: TaskPresentationRole) {
 return (task: Task): TaskPresentation => ({
  id: task.id,
  subject: task.subject,
  role,
 });
}

function deriveCurrentRole(
 state: TaskState,
 task: Task,
): "running" | "ready" | "blocked" {
 if (task.status === "in_progress") return "running";
 // pending: ready iff no unsatisfied deps; otherwise blocked.
 return classifyTask(state, task) === "ready" ? "ready" : "blocked";
}
