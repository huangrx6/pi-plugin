/**
 * mutation-outcome.ts — P1-C (outcome materialization).
 *
 * Pure materialization: prev + next + plan → MutationOutcome.
 * This is the ONLY P1-C path allowed to consume TaskState and
 * projection. mutation-format.ts only consumes the resulting
 * MutationOutcome (no TaskState, no projection read).
 *
 * Module invariants (P1-C LOCK):
 *   1. buildMutationOutcome is the only path that reads prev/next.
 *   2. Targets are derived from the FROZEN `next` state via
 *      classifyTask (canonical projection). No command-kind inference.
 *      In particular, `reopen` does NOT imply BLOCKED.
 *   3. diff is computed via diffActiveView (canonical B1 primitive).
 *   4. depsMap for secondary consequence rows is built via
 *      read-model.buildDependencyPresentation. Formatter never
 *      re-derives membership/filter.
 *   5. No persistence, no reducer execution, no formatting output.
 *   6. NO `changedTargetIds` field — successful targets come from
 *      the frozen MutationPlan.targetIds. No invented equality semantics.
 *   7. NO prev / next TaskState fields in MutationOutcome. State never
 *      crosses this boundary; the formatter cannot leak through.
 */

import { buildDependencyPresentation } from "./read-model.ts";
import { classifyTask, diffActiveView } from "./projection.ts";
import type {
 ActiveViewDiff,
 MutationCommand,
 TaskDependencyPresentation,
 TaskId,
 TaskState,
 TaskStatus,
} from "./types.ts";
import type { MutationPlan } from "./mutation-executor.ts";

/** Canonical command kind string. */
export type CommandKind = "start" | "finish" | "reopen" | "close" | "archive" | "restore";

/**
 * Canonical target presentation (frozen from `next` via classifyTask).
 * Formatter reads role + subject + status only; never inspects raw Task.
 */
export interface MutationTargetPresentation {
 readonly id: TaskId;
 readonly subject: string;
 /** Final role from classifyTask. NOT inferred from command kind. */
 readonly role: "running" | "ready" | "blocked" | "completed" | "closed" | "archived";
 /** Final lifecycle status. */
 readonly status: TaskStatus;
}

/**
 * Formatter-ready mutation outcome. NO TaskState fields.
 * This is the ONLY data the formatter sees.
 */
export interface MutationOutcome {
 readonly commandKind: CommandKind;
 /** Frozen from the plan. NO additional filtering or re-derivation. */
 readonly targetIds: readonly TaskId[];
 readonly targets: readonly MutationTargetPresentation[];
 /** Computed via diffActiveView(prev, next) — complete, no exclusion. */
 readonly diff: ActiveViewDiff;
 /** Per-task deps for secondary consequence rows. Keys = task ids
  *  present in diff.becameBlocked. Formatter reads via depsMap.get(id). */
 readonly depsMap: ReadonlyMap<TaskId, readonly TaskDependencyPresentation[]>;
}

/**
 * Build a MutationOutcome from prev / next / plan.
 * ONLY this function reads prev/next TaskState.
 */
export function buildMutationOutcome(
 prev: TaskState,
 next: TaskState,
 plan: MutationPlan,
): MutationOutcome {
 const diff = diffActiveView(prev, next);

 // Canonical target presentations from `next` state.
 // classifyTask returns undefined for non-active tasks (archived / deleted
 // / completed). We need a richer fallback than "completed" because
 // archived is a distinct role (· icon, not ✓).
 const targets: MutationTargetPresentation[] = plan.targetIds.map((id) => {
  const task = next.tasks.find((t) => t.id === id);
  if (!task) {
   // Defensive: should never happen (targetIds came from a successfully
   // applied plan). Sentinel; the formatter can detect via status="deleted".
   return {
    id,
    subject: "(task missing after mutation)",
    role: "completed",
    status: "deleted" as TaskStatus,
   };
  }
  const role = deriveRole(next, task);
  return {
   id,
   subject: task.subject,
   role,
   status: task.status,
  };
 });

 /** Derive a canonical role for a task. Visibility FIRST (archived),
  * then lifecycle status (completed, deleted), then projection. */
 function deriveRole(
  state: TaskState,
  task: TaskState["tasks"][number],
 ): MutationTargetPresentation["role"] {
  if (task.archivedAt !== undefined) return "archived";
  if (task.status === "deleted") return "completed"; // tombstone sentinel
   if (task.closedAt !== undefined) return "closed";
   if (task.status === "completed") return "completed";
  return classifyTask(state, task) ?? "completed";
 }

 // Deps map for BLOCKED consequences only.
 const depsMap = new Map<TaskId, readonly TaskDependencyPresentation[]>();
 for (const t of diff.becameBlocked) {
  depsMap.set(t.id, buildDependencyPresentation(next, t.id));
 }

 return {
  commandKind: plan.command.kind,
  targetIds: plan.targetIds,
  targets,
  diff,
  depsMap,
 };
}

// Re-export the source command type for callers that need it.
export type { MutationCommand };
