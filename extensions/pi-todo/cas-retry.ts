/**
 * cas-retry.ts — file-durable todo state uses compare-and-swap:
 * every successful commit advances the envelope revision, and any
 * later commit that submits a stale baseRevision gets a "conflict"
 * outcome instead of overwriting.
 *
 * When a single session emits N commits back-to-back (e.g. an agent
 * creates 5 todos in one turn), only the first sees the fresh
 * baseRevision; the rest conflict and used to surface as
 * "Todo state changed in another session" even though the conflict
 * is purely an artefact of the agent's own previous commit.
 *
 * `withCasRetry` runs the supplied attempt up to `maxAttempts`
 * times, retrying only on `cas-conflict` outcomes. Any other
 * outcome (a successful commit, or a domain error surfaced as
 * `ok` by the caller) returns immediately. Backoff is linear:
 * attempt N waits delayFn(N-1) ms before re-running, where
 * delayFn defaults to 15 * N (i.e. 15ms then 30ms between the
 * three default attempts).
 *
 * If every attempt conflicts, returns the last conflict so the
 * caller can surface a faithful "now at revision X" message.
 * The attempt function is responsible for re-loading the
 * envelope each call — retrying against a stale in-memory copy
 * would defeat the point.
 *
 * Module invariants (P3-A LOCK-compatible, no domain authority):
 *   1. `withCasRetry` is the only place that translates CAS
 *      conflict into retry behaviour. Reducer / durable store
 *      remain unaware of retry semantics.
 *   2. Backoff is bounded — never exponential, never indefinite.
 *      File I/O contention on a single host resolves in <100ms;
 *      longer waits belong to a higher layer.
 *   3. Caller-owned attempt must be safe to invoke repeatedly
 *      and must surface a fresh envelope revision each call.
 */

export type CasOutcome<T> =
 | { kind: "ok"; value: T }
 | { kind: "cas-conflict"; actualRevision: number };

export interface CasRetryOptions {
 /** Total attempts including the first try. Default 3. */
 maxAttempts?: number;
 /** ms to wait before attempt N (1-indexed). Default: 15 * N. */
 delayMs?: (attemptIndex: number) => number;
}

export const DEFAULT_CAS_RETRY: Required<CasRetryOptions> = {
 maxAttempts: 3,
 delayMs: (i) => 15 * i,
};

export async function withCasRetry<T>(
 attempt: () => Promise<CasOutcome<T>>,
 options: CasRetryOptions = {},
): Promise<CasOutcome<T>> {
 const opts = { ...DEFAULT_CAS_RETRY, ...options };
 let last: { kind: "cas-conflict"; actualRevision: number } | undefined;
 for (let i = 0; i < opts.maxAttempts; i++) {
  const result = await attempt();
  if (result.kind === "ok") return result;
  last = result;
  if (i < opts.maxAttempts - 1) {
   await new Promise<void>((resolve) =>
    setTimeout(resolve, opts.delayMs(i + 1)),
   );
  }
 }
 return last ?? { kind: "cas-conflict", actualRevision: 0 };
}
