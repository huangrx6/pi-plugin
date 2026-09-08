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
 * A second, harsher contention source exists: the SAME conversation
 * opened in two pi processes (resume/continue in another terminal)
 * shares one sessionId, hence one scope file. Both processes then
 * commit real bursts against that file, and a 45ms retry window
 * loses against an actively-writing peer. The default budget is
 * therefore sized to ride out a realistic burst: 8 attempts with
 * 30ms linear steps (~840ms total worst case).
 *
 * `withCasRetry` runs the supplied attempt up to `maxAttempts`
 * times, retrying only on `cas-conflict` outcomes. Any other
 * outcome (a successful commit, or a domain error surfaced as
 * `ok` by the caller) returns immediately. Backoff is linear:
 * attempt N waits delayFn(N-1) ms before re-running, where
 * delayFn defaults to 30 * N.
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
 *   2. Backoff is bounded and linear — never exponential, never
 *      indefinite. Same-session dual-process bursts resolve well
 *      under a second on a single host; longer waits belong to a
 *      higher layer.
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
 maxAttempts: 8,
 delayMs: (i) => 30 * i,
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
