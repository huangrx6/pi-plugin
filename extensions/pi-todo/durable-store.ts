/**
 * durable-store.ts — P3-B.3 (DurableTodoStore interface + reference impl).
 *
 * Public API:
 *   - DurableTodoStore interface (ScopeKey-only, never ctx).
 *   - CommitResult discriminated union (committed | conflict).
 *   - createInMemoryDurableTodoStore factory.
 *
 * Module invariants (P3-B LOCK):
 *   1. API accepts ScopeKey only. NEVER sid(ctx) / ctx / sessionId.
 *   2. load missing → in-memory empty envelope; 0 writes.
 *   3. commit owns schemaVersion (CURRENT) and revision construction.
 *   4. Strict CAS R → R+1; no transparent retry.
 *   5. NO state-equality inference (caller decides whether to commit).
 *   6. Snapshot isolation: commit captures a detached state snapshot;
 *      load never exposes mutable store-owned references (P3-B §24).
 *   7. P3-B does NOT implement production ScopeKeyResolver.
 *      P3-B does NOT implement journal / replay.
 *   8. Per-scope in-process lock for CAS concurrency (process-local).
 *      Cross-process CAS requires explicit backend support.
 *   9. P3-B owns no CLI UX.
 *
 * This module is the refactored P3-B.2/3 surface (interface + reference
 * implementation). File backend (P3-B.4) lives in
 * file-durable-store.ts; both implement DurableTodoStore.
 */

import {
 CURRENT_SCHEMA_VERSION,
 type CurrentPersistedTodoEnvelope,
 type ScopeKey,
} from "./persistence-contract.ts";
import { EMPTY_STATE, type TaskState } from "./types.ts";

// ── CommitResult ─────────────────────────────────────────────────────────

export type CommitResult =
 | {
    readonly kind: "committed";
    readonly envelope: CurrentPersistedTodoEnvelope;
   }
 | {
    readonly kind: "conflict";
    readonly expectedRevision: number;
    readonly actualRevision: number;
   };

// ── Interface ───────────────────────────────────────────────────────────

export interface DurableTodoStore {
 load(scope: ScopeKey): Promise<CurrentPersistedTodoEnvelope>;
 commit(
  scope: ScopeKey,
  expectedRevision: number,
  nextState: TaskState,
 ): Promise<CommitResult>;
}

// ── Internal: empty envelope materialization ─────────────────────────────

function emptyEnvelope(): CurrentPersistedTodoEnvelope {
 return {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  revision: 0,
  state: { ...EMPTY_STATE },
 };
}

// ── In-memory reference implementation (P3-B.3) ────────────────────────

/**
 * Process-local DurableTodoStore. Useful as a CAS-correctness
 * reference; not durable across process restart (use file-durable-store
 * for real durability). Snapshot-isolated: caller mutations after
 * commit/load do NOT affect store-owned state.
 */
export function createInMemoryDurableTodoStore(): DurableTodoStore {
 const envelopes = new Map<ScopeKey, CurrentPersistedTodoEnvelope>();
 // Per-scope in-process lock chain for CAS concurrency.
 const locks = new Map<ScopeKey, Promise<unknown>>();

 async function withLock<T>(
  scope: ScopeKey,
  fn: () => Promise<T> | T,
 ): Promise<T> {
  const prev = locks.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
   release = r;
  });
  const chained = prev.then(() => next);
  locks.set(scope, chained);
  try {
   return await Promise.resolve(prev).then(fn);
  } finally {
   release();
   // Cleanup: only remove the entry if it's still our tail (avoid race).
   if (locks.get(scope) === chained) {
    locks.delete(scope);
   }
  }
 }

 async function load(scope: ScopeKey): Promise<CurrentPersistedTodoEnvelope> {
  const env = envelopes.get(scope);
  if (env) {
   // Snapshot isolation: return a detached copy.
   return {
    schemaVersion: env.schemaVersion,
    revision: env.revision,
    state: structuredClone(env.state),
   };
  }
  return emptyEnvelope();
 }

 async function commit(
  scope: ScopeKey,
  expectedRevision: number,
  nextState: TaskState,
 ): Promise<CommitResult> {
  return withLock(scope, () => {
   const current = envelopes.get(scope) ?? emptyEnvelope();
   if (current.revision !== expectedRevision) {
    return {
     kind: "conflict" as const,
     expectedRevision,
     actualRevision: current.revision,
    };
   }
   const envelope: CurrentPersistedTodoEnvelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: expectedRevision + 1,
    state: structuredClone(nextState),
   };
   envelopes.set(scope, envelope);
   return { kind: "committed" as const, envelope };
  });
 }

 return { load, commit };
}
