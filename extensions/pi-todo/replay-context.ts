/**
 * replay-context.ts — P3-D.1 (ReplayContextSession factory).
 *
 * Materializes runtime ReduceContext from persisted observations
 * (PersistedReduceContext). Linear consumption of nowValues.
 *
 * Module invariants:
 *   1. nowValues is consumed in order — no random access, no replay.
 *   2. now() throws when cursor >= nowValues.length (underflow
 *      detected at the reducer boundary; P3-D's replay-engine wraps
 *      it as ReplayIntegrityError).
 *   3. assertAllConsumed() throws when cursor < nowValues.length
 *      (overflow; P3-D wraps as ReplayIntegrityError).
 *   4. Each session is single-use (consume-then-discard).
 *   5. Internal error classes are NOT exported — they are wrapped at
 *      the replay-engine boundary.
 *   6. No external mutation of inputs.
 */

import type {
 PersistedReduceContext,
 ReplayContextAdapter,
 ReplayContextSession,
} from "./persistence-contract.ts";
import type { ReduceContext } from "./types.ts";

// ── Internal error classes (not exported) ──────────────────────────────

class ReplayContextUnderflowError extends Error {
 readonly kind = "replay-context-underflow" as const;
 constructor(message: string) {
  super(message);
  this.name = "ReplayContextUnderflowError";
 }
}

class ReplayContextOverflowError extends Error {
 readonly kind = "replay-context-overflow" as const;
 constructor(message: string) {
  super(message);
  this.name = "ReplayContextOverflowError";
 }
}

// ── Public factory ──────────────────────────────────────────────────────

/**
 * Construct a fresh ReplayContextSession from a persisted
 * observations snapshot. The session's `reduceContext.now()` consumes
 * `persisted.nowValues` in order. The session's
 * `assertAllConsumed()` MUST be called after all replay actions
 * complete; it reports any unused recorded values (overflow).
 *
 * Each call returns a fresh single-use session. The factory is
 * pure with respect to its input.
 */
export function fromPersisted(
 persisted: PersistedReduceContext,
): ReplayContextSession {
 let index = 0;

 const reduceContext: Pick<ReduceContext, "now"> = {
  now: () => {
   if (index >= persisted.nowValues.length) {
    throw new ReplayContextUnderflowError(
     `ctx.now() requested at index ${index} but only ${persisted.nowValues.length} values recorded`,
    );
   }
   return persisted.nowValues[index++] as number;
  },
 };

 return {
  reduceContext,
  assertAllConsumed(): void {
   if (index < persisted.nowValues.length) {
    throw new ReplayContextOverflowError(
     `${persisted.nowValues.length - index} recorded nowValues were never consumed during replay`,
    );
   }
  },
 };
}

/**
 * Construct a ReplayContextAdapter instance. Useful for callers
 * that want to inject the adapter into dependency-injection-style
 * sites; most callers should use `fromPersisted` directly.
 */
export function createReplayContextAdapter(): ReplayContextAdapter {
 return { fromPersisted };
}
