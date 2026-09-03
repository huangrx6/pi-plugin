/**
 * replay-engine.ts — P3-D.2 + P3-D.3 (single + chain replay).
 *
 * Deterministic reconstruction of TaskState from ReplayMutationMaterial.
 * Pure: does not mutate inputs, does not write to durable backend.
 *
 * Module invariants (P3-D LOCK):
 *   1. P3-D introduces no persistent journal.
 *   2. Replay consumes materialized actions in stored order.
 *   3. applyTaskMutation is sole domain-transition authority.
 *   4. Reducer failure during replay → ReplayIntegrityError (not P1).
 *   5. Replay does not mutate base or material.
 *   6. Single material invariants:
 *        base.revision == material.baseRevision
 *        material.revision == material.baseRevision + 1
 *        material.actions.length >= 1   (LOCK §21: empty no-op
 *                                         cannot produce replay material)
 *   7. Chain requires contiguous R → R+1 sequence.
 *   8. Successful chain returns RecoveryCandidate only; no commit.
 *   9. Snapshot isolation: base.state is structuredClone'd so caller
 *      mutations cannot affect replay or the produced result
 *      (LOCK §26).
 *  10. No durable store / CLI / scope / session identity reads.
 *  11. Only runtime dep: reducer (sole domain semantic).
 *  12. All execution / context failures (underflow, overflow,
 *      reducer-thrown) are wrapped as ReplayIntegrityError at the
 *      replay-engine boundary. Internal context errors are NOT
 *      exported.
 */

import { applyTaskMutation } from "./reducer.ts";
import type { ReduceContext, TaskMutationParams, TaskState } from "./types.ts";
import type { ReplayMutationMaterial } from "./persistence-contract.ts";
import { fromPersisted } from "./replay-context.ts";

// ── Public error type ──────────────────────────────────────────────────

/**
 * The single replay-integrity failure type exposed by P3-D. All
 * replay-time failures (base revision mismatch, material revision
 * jump, empty committed material, reducer rejection, context
 * underflow, context overflow) are normalized to this type at the
 * replay-engine boundary.
 */
export class ReplayIntegrityError extends Error {
 readonly kind = "replay-integrity" as const;
 constructor(
  message: string,
  readonly cause?: unknown,
 ) {
  super(message);
  this.name = "ReplayIntegrityError";
 }
}

// ── Public types (P3-D local; NOT shared with P3-B envelope) ─────────

/**
 * Input state to replay. P3-D does NOT accept a
 * CurrentPersistedTodoEnvelope here — schemaVersion is P3-B's
 * concern; replay reconstruction is domain-only.
 */
export interface ReplayState {
 readonly revision: number;
 readonly state: TaskState;
}

/**
 * Output of single-material replay. Schema-free reconstruction result.
 */
export interface ReplayResult {
 readonly revision: number;
 readonly state: TaskState;
}

/**
 * Output of chain replay. Called RecoveryCandidate because v0 P3-D
 * MUST NOT auto-commit. Promoting a candidate to durable state is
 * an explicit P3-E / P3-B operation.
 */
export interface RecoveryCandidate {
 readonly baseRevision: number;
 readonly finalRevision: number;
 readonly state: TaskState;
}

// ── Internal invariants ──────────────────────────────────────────────

function assertSingleMaterialInvariants(
 base: ReplayState,
 material: ReplayMutationMaterial,
): void {
 // LOCK §21: committed replay material MUST contain at least one
 // materialized action. Empty no-op never advances revision and
 // therefore never produces replay material.
 if (material.actions.length === 0) {
  throw new ReplayIntegrityError(
   "committed replay material contains no actions",
  );
 }
 if (base.revision !== material.baseRevision) {
  throw new ReplayIntegrityError(
   `base revision ${base.revision} does not match material.baseRevision ${material.baseRevision}`,
  );
 }
 if (material.revision !== material.baseRevision + 1) {
  throw new ReplayIntegrityError(
   `material.revision ${material.revision} must equal baseRevision + 1 (${material.baseRevision + 1})`,
  );
 }
}

// ── D.2 single material replay ──────────────────────────────────────

/**
 * Replay one frozen material against a base state.
 * Throws ReplayIntegrityError on any inconsistency. Returns new
 * ReplayResult on success; does not mutate base or material.
 */
export function replayMutationMaterial(
 base: ReplayState,
 material: ReplayMutationMaterial,
): ReplayResult {
 // LOCK §26: snapshot isolation. Detached copy so caller mutations
 // to base or material do not affect replay or the produced result.
 let state: TaskState = structuredClone(base.state);

 // Invariants throw ReplayIntegrityError BEFORE any state mutation.
 assertSingleMaterialInvariants(base, material);

 // Build replay context session (P3-A Amendment A2 shape).
 const session = fromPersisted(material.replayContext);

 // Apply actions sequentially in stored order, no filter / sort.
 for (const action of material.actions) {
  let applied;
  try {
   applied = applyTaskMutation(state, action, session.reduceContext);
  } catch (cause) {
   // LOCK §13 / §19: underflow (now() beyond recorded values) or any
   // other reducer-thrown error is wrapped as ReplayIntegrityError.
   throw new ReplayIntegrityError(
    `replay execution failed at action: ${JSON.stringify(action)}`,
    cause,
   );
  }
  if (applied.op.kind === "error") {
   // LOCK §16: reducer failure (e.g. illegal transition) during
   // replay is replay-integrity, NOT P1-C MutationCliError domain.
   throw new ReplayIntegrityError(
    `reducer rejected frozen material action: ${applied.op.error.code}`,
    applied.op.error,
   );
  }
  state = applied.state;
 }

 // LOCK §14: overflow check (underflow already throws via ctx.now()).
 try {
  session.assertAllConsumed();
 } catch (cause) {
  throw new ReplayIntegrityError(
   `unused recorded nowValues after replay`,
   cause,
  );
 }

 return { revision: material.revision, state };
}

// ── D.3 chain replay / recovery candidate ────────────────────────────

/**
 * Replay a contiguous chain of materials against a base.
 * Throws ReplayIntegrityError on gap / duplicate / jump. Returns
 * RecoveryCandidate on success; never commits.
 */
export function replayMutationChain(
 base: ReplayState,
 materials: readonly ReplayMutationMaterial[],
): RecoveryCandidate {
 let state: TaskState = structuredClone(base.state);
 let revision = base.revision;

 for (let i = 0; i < materials.length; i++) {
  const m = materials[i] as ReplayMutationMaterial;
  if (m.baseRevision !== revision) {
   throw new ReplayIntegrityError(
    `chain material[${i}].baseRevision ${m.baseRevision} does not match current chain revision ${revision}`,
   );
  }
  const result = replayMutationMaterial({ revision, state }, m);
  revision = result.revision;
  state = result.state;
 }

 return {
  baseRevision: base.revision,
  finalRevision: revision,
  state,
 };
}
