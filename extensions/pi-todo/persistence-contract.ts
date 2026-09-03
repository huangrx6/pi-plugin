/**
 * persistence-contract.ts — P3-A (temporal persistence contract).
 *
 * Type-only definitions for the durable authority of todo state.
 * NO runtime persistence implementation lives in this file. The
 * storage adapter (file / host storage / other) is built in P3-B
 * on top of these types.
 *
 * Module invariants (P3-A LOCK):
 *
 *   AUTHORITY MODEL
 *
 *     Reducer       = sole authority for domain state transitions.
 *     Durable store = sole authority for persisted envelope
 *                     revision / schema / CAS writes.
 *     Persistence MUST NOT repair, normalize, infer, or rewrite
 *     TaskState domain semantics.
 *
 *     Runtime session id  ≠ durable identity (no default resolver
 *     defined in P3-A; P3-B / P3-C chooses one).
 *
 *   ENVELOPE
 *
 *   1. Persisted state wrapped in PersistedTodoEnvelope.
 *   2. Envelope is the single source of truth for durable state.
 *   3. Envelope is readonly; durable store is the sole author.
 *   4. Every envelope has a monotonically increasing revision.
 *   5. Revision advances ONLY on an actual successful durable
 *      commit. Read-only commands, syntax failures, domain failures,
 *      selector-empty successful no-ops, and CAS conflicts do NOT
 *      advance revision.
 *   6. schemaVersion is a generic numeric tag so any supported
 *      historical or current version can be represented. v0 is
 *      version 1.
 *
 *   MIGRATION
 *
 *   7. Migrations are pure / deterministic / versioned functions
 *      from old envelope to new envelope.
 *   8. Older supported schemaVersions migrate forward before
 *      domain use.
 *   9. Unknown future schemaVersions fail closed.
 *  10. Successful writes persist CURRENT_SCHEMA_VERSION.
 *
 *   REPLAY MATERIAL
 *
 *  11. Replay material is ReplayMutationMaterial: baseRevision,
 *      revision, actions (already-materialized TaskMutationParams),
 *      replayContext (PersistedReduceContext).
 *  12. Replay never reparses raw CLI, never re-resolves selectors.
 *      It consumes the already-materialized committed actions
 *      against the exact replay base state.
 *  13. ReduceContext (runtime capability, function-bearing) is
 *      NEVER persisted. PersistedReduceContext captures the ordered
 *      sequence of ctx.now() return values consumed during the
 *      original execution.
 *  14. P3-A does NOT define a journal / commit record format. That
 *      is P3-D's decision (audit / recovery / sequence may differ
 *      from the minimal replay material).
 *
 *   SCOPE KEY
 *
 *  15. ScopeKey is opaque-branded. Plain strings cannot be assigned
 *      to it. Construction must go through a ScopeKeyResolver or an
 *      explicit construction boundary.
 *  16. Runtime session id is NOT a ScopeKey. P3-A defines no default
 *      resolver; P3-B / P3-C selects the first runtime strategy.
 *  17. ScopeKeyResolver.resolve is async (realpath on POSIX is
 *      intrinsically async; P3-C workspace resolver requires this).
 *
 *   FROZEN
 *
 *  18. P0 / P1 / P2 remain FROZEN. This file imports only types from
 *      types.ts.
 *
 *   AMENDMENT A2
 *
 *  A2. ReplayContextAdapter upgraded to expose consumption
 *      verification. See ReplayContextSession below. No change to
 *      persisted schema.
 */

import type { ReduceContext, TaskMutationParams, TaskState } from "./types.ts";

// ── Schema versioning ────────────────────────────────────────────────────

/** Current schema version. Bump on envelope shape changes only. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

// ── Scope key (durable task namespace) ────────────────────────────────────

declare const scopeKeyBrand: unique symbol;

/**
 * Stable identifier of a persistent todo state. Opaque-branded:
 * plain strings cannot be assigned to ScopeKey. Construct via a
 * ScopeKeyResolver or an explicit `as ScopeKey` boundary.
 *
 * Runtime session id is NOT a ScopeKey. P3-A defines no default
 * resolver; P3-B / P3-C selects the first runtime resolution
 * strategy.
 */
export type ScopeKey = string & {
 readonly [scopeKeyBrand]: "ScopeKey";
};

/**
 * Pluggable strategy for deriving ScopeKey from runtime context.
 * P3-A ships no default implementation. The first runtime resolver
 * is selected in P3-B / P3-C; until then, callers must explicitly
 * wire one.
 *
 * `resolve` is async: real-world implementations (P3-C workspace
 * resolver) canonicalize via fs.realpath, which is intrinsically
 * async on POSIX systems. P3-A's contract admits both sync and
 * async implementations; async is required by the canonical v0.
 */
export interface ScopeKeyResolver<Ctx = unknown> {
 resolve(ctx: Ctx): Promise<ScopeKey>;
}

// ── Envelope (durable authority) ──────────────────────────────────────────

/**
 * Persisted state envelope. Generic in schemaVersion so that any
 * supported historical or current version can be represented in the
 * type system. Load / decode / migration code uses the generic form;
 * successful durable writes always produce CurrentPersistedTodoEnvelope.
 */
export interface PersistedTodoEnvelope<V extends number = number> {
 readonly schemaVersion: V;
 readonly revision: number;
 readonly state: TaskState;
}

/**
 * Envelope shape produced by successful durable writes today.
 * Equivalent to PersistedTodoEnvelope<CURRENT_SCHEMA_VERSION>.
 */
export type CurrentPersistedTodoEnvelope = PersistedTodoEnvelope<
 typeof CURRENT_SCHEMA_VERSION
>;

// ── Persisted reduce context (replay data) ──────────────────────────────

/**
 * Deterministic replay data extracted from runtime ReduceContext.
 * The reducer uses ctx.now() for all timestamp writes, so the
 * ordered sequence of observed now() values is sufficient to
 * reproduce the timestamps that the original execution produced.
 *
 * No length is asserted against actions. The reducer may call
 * ctx.now() zero, one, or multiple times per action; the contract
 * only requires that the ordered sequence be reproducible.
 *
 * ReduceContext (runtime capability, function-bearing) MUST NEVER
 * be persisted directly.
 */
export interface PersistedReduceContext {
 readonly nowValues: readonly number[];
}

// ── Replay material (minimum for deterministic replay) ─────────────────

/**
 * Minimum material required to deterministically reproduce one
 * committed mutation. The actual journal / commit record format
 * (P3-D) may wrap this in additional metadata (sequence, wall-clock,
 * audit fields); the replay material itself is exactly these four
 * fields.
 *
 * Replay consumes already-materialized TaskMutationParams against
 * the exact replay base state. It never re-parses raw CLI and
 * never re-resolves selectors (LOCK §12).
 */
export interface ReplayMutationMaterial {
 readonly baseRevision: number;
 readonly revision: number;
 readonly actions: readonly TaskMutationParams[];
 readonly replayContext: PersistedReduceContext;
}

// ── Replay context adapter (P3-A Amendment A2) ────────────────────────

/**
 * Active replay session. Materializes a runtime ReduceContext from
 * persisted observations and exposes consumption verification.
 *
 * `reduceContext` is fed to the frozen reducer during replay.
 * `assertAllConsumed` MUST be called after all actions run; it
 * reports any unused recorded nowValues (overflow = integrity fail).
 *
 * P3-A AMENDMENT A2: original interface only returned
 * `Pick<ReduceContext, "now">`; that was insufficient for P3-D's
 * deterministic-replay contract (which requires underflow +
 * overflow verification at the same boundary). Amendment A2
 * promotes the return shape to ReplayContextSession without
 * changing the persisted schema.
 */
export interface ReplayContextSession {
 readonly reduceContext: Pick<ReduceContext, "now">;
 assertAllConsumed(): void;
}

/**
 * Adapter that materializes ReplayContextSession from a persisted
 * observations snapshot. P3-D supplies the runtime implementation.
 */
export interface ReplayContextAdapter {
 fromPersisted(persisted: PersistedReduceContext): ReplayContextSession;
}
