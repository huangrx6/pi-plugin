/**
 * mutation-executor.ts — P1-B: MutationPlan + Atomic Executor.
 *
 * Layer chain (P1-B is the transaction primitive):
 *   parsed command
 *     → validate (P1-A)
 *     → resolveSelectorIds once (P1-A)
 *     → freeze targetIds
 *     → buildMutationPlan(command, targetIds)   ← here
 *     → applyMutationPlan(initial, plan, ctx)   ← here, pure
 *     → caller commits `next` exactly once
 *
 * Module invariants (P1-B LOCK):
 *   1. MutationPlan is materialized exactly once via buildMutationPlan().
 *      `actions` is structurally derived from (command × targetIds) — caller
 *      cannot supply arbitrary action lists.
 *   2. buildMutationPlan reads no state. targetIds are FROZEN from the
 *      P1-A resolver; re-resolving here would break the snapshot contract.
 *   3. Lifecycle commands (start/finish/reopen) build single-id actions
 *      from command.id; selector commands (archive/restore) build ids[]
 *      actions per targetId. No funneling of lifecycle through
 *      resolveSelectorIds.
 *   4. applyMutationPlan is PURE:
 *      - no persistence (no commit)
 *      - no formatting
 *      - no selector resolution
 *      - no projection
 *      - only folds reducer actions against an executor-local candidate.
 *   5. Reducer actions folded sequentially in plan.actions order. Order is
 *      inherited from targetIds (which preserves user-declared order).
 *   6. Fail-fast: the first reducer failure terminates the plan; later
 *      actions are NEVER executed.
 *   7. Failure result NEVER exposes partial state. Intermediate candidates
 *      are executor-local and never returned.
 *   8. Empty plan (named selector resolved to []) → ok with initial as
 *      next. Successful no-op. No commit.
 *   9. Persistence is the CALLER's job (P1-D / wiring layer). At most one
 *      commit per CLI command, only after full plan success.
 */

import { applyTaskMutation } from "./reducer.ts";
import type {
 MutationCommand,
 MutationError,
 ReduceContext,
 TaskId,
 TaskMutationParams,
 TaskState,
} from "./types.ts";

// ── MutationPlan ────────────────────────────────────────────────────────────

/**
 * Frozen mutation plan: command + ordered targetIds + structurally-
 * derived reducer actions. Created only via buildMutationPlan.
 */
export interface MutationPlan {
 readonly command: MutationCommand;
 readonly targetIds: readonly TaskId[];
 readonly actions: readonly TaskMutationParams[];
}

/**
 * Build a MutationPlan from a validated command and frozen targetIds.
 * Pure: no state read, no re-resolution, no side effects.
 *
 * `actions[i]` corresponds to `targetIds[i]`:
 *   - lifecycle command: actions[i] = { action: command.kind, id: targetIds[i] }
 *   - archive / restore: actions[i] = { action: command.kind, ids: [targetIds[i]] }
 */
export function buildMutationPlan(
 command: MutationCommand,
 targetIds: readonly TaskId[],
): MutationPlan {
 const actions: TaskMutationParams[] = targetIds.map((id) =>
  buildAction(command, id),
 );
 return { command, targetIds, actions };
}

function buildAction(command: MutationCommand, id: TaskId): TaskMutationParams {
 switch (command.kind) {
  case "start":
   return { action: "start", id };
  case "finish":
   return { action: "finish", id };
  case "reopen":
   return { action: "reopen", id };
  case "close":
   return { action: "close", id };
  case "archive":
   return { action: "archive", ids: [id] };
  case "restore":
   return { action: "restore", ids: [id] };
 }
}

// ── Atomic Executor ──────────────────────────────────────────────────────

export type ApplyMutationPlanResult =
 | { ok: true; next: TaskState }
 | {
    ok: false;
    error: MutationError;
    failedTargetId: TaskId;
    failedActionIndex: number;
   };

/**
 * Fold the plan's reducer actions against `initial` state in order.
 * Pure — no persistence, no formatting, no projection. See module header.
 *
 * Behavior matrix (LOCKED P1-B):
 *   empty plan                → { ok: true, next: initial }   (successful no-op)
 *   all actions success        → { ok: true, next: final candidate }
 *   action #i fails            → { ok: false, error, failedTargetId: targetIds[i],
 *                                  failedActionIndex: i }
 *                                (no later actions executed; no next exposed)
 *
 * Caller responsibility: after `ok: true`, perform exactly one commit. After
 * `ok: false`, do NOT touch state.
 */
export function applyMutationPlan(
 initial: TaskState,
 plan: MutationPlan,
 ctx: ReduceContext,
): ApplyMutationPlanResult {
 let candidate = initial;
 for (let i = 0; i < plan.actions.length; i++) {
  const params = plan.actions[i] as TaskMutationParams;
  const result = applyTaskMutation(candidate, params, ctx);
  if (result.op.kind === "error") {
   // Fail-fast: discard candidate, do NOT execute later actions.
   return {
    ok: false,
    error: result.op.error,
    failedTargetId: plan.targetIds[i] as TaskId,
    failedActionIndex: i,
   };
  }
  candidate = result.state;
 }
 return { ok: true, next: candidate };
}
