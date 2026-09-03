/**
 * replay-capture.ts — P3-E (production ReduceContext capture).
 *
 * Wraps the runtime clock so every actual ctx.now() call records its
 * return value into an ordered sequence, suitable for building
 * provisional ReplayMutationMaterial.
 *
 * Module invariants (P3-E LOCK):
 *   1. nowValues is appended in true execution order.
 *   2. One action may consume zero, one, or many nowValues.
 *   3. Empty semantic no-op executes no mutation action and records no
 *      reducer time observations. (P3-E LOCK §35)
 *   4. snapshotNowValues() returns a frozen detached copy — caller
 *      cannot mutate the live sequence through it. (P3-E LOCK §38)
 *   5. Caller controls the clock (defaults to Date.now).
 */

import type { ReduceContext } from "./types.ts";

export interface ObservedReduceContext {
 readonly reduceContext: ReduceContext;
 readonly nowValues: readonly number[];
 /**
  * Returns a frozen, detached snapshot of the observed now() values.
  * Safe to embed in ReplayMutationMaterial.replayContext.
  */
 snapshotNowValues(): readonly number[];
}

export function createObservedReduceContext(
 now: () => number = Date.now,
): ObservedReduceContext {
 const nowValues: number[] = [];
 const reduceContext: ReduceContext = {
  now: () => {
   const v = now();
   nowValues.push(v);
   return v;
  },
 };
 return {
  reduceContext,
  get nowValues(): readonly number[] {
   return nowValues;
  },
  snapshotNowValues(): readonly number[] {
   return Object.freeze([...nowValues]);
  },
 };
}
