/**
 * overlay-snapshot-cache.ts — P3-E (overlay presentation cache).
 *
 * ScopeKey-keyed presentation cache that decouples the sync overlay
 * render path from the async durable load path.
 *
 * Module invariants (P3-E LOCK §27-28):
 *   1. Cached state is presentation-only.
 *   2. The cache MUST NOT be used as input to mutation pre-state /
 *      B3 read / P2 query / CAS expected revision.
 *   3. The cache is updated ONLY after a successful durable load or
 *      a successful durable CAS commit.
 *   4. Keyed by ScopeKey, not sessionId.
 *   5. When the current scope has no entry, getOrEmpty returns an
 *      empty TaskState — NOT a fabricated semantic state.
 *   6. Scope → state. No revision stored; revision lives only in
 *      durable authority (P3-B).
 */

import type { TaskState } from "./types.ts";
import type {
 CurrentPersistedTodoEnvelope,
 ScopeKey,
} from "./persistence-contract.ts";

const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

export class OverlaySnapshotCache {
 private readonly cache = new Map<ScopeKey, CurrentPersistedTodoEnvelope>();

 /**
  * Update the cache for a scope with a freshly-loaded or committed
  * envelope. Caller MUST only invoke this after a successful durable
  * load / commit.
  */
 update(scope: ScopeKey, envelope: CurrentPersistedTodoEnvelope): void {
  this.cache.set(scope, envelope);
 }

 /**
  * Discard a cached scope. Called when a scope is no longer relevant
  * (e.g. evictSession in P3-E).
  */
 invalidate(scope: ScopeKey): void {
  this.cache.delete(scope);
 }

 /**
  * Sync overlay source. Returns the cached state for a scope, or
  * EMPTY_STATE if the scope has not been loaded / committed in this
  * process. NEVER throws.
  */
 getOrEmpty(scope: ScopeKey): TaskState {
  return this.cache.get(scope)?.state ?? EMPTY_STATE;
 }

 /**
  * Test / introspection only. Returns the cached envelope for a scope
  * or undefined. Not used by production overlay.
  */
 peek(scope: ScopeKey): CurrentPersistedTodoEnvelope | undefined {
  return this.cache.get(scope);
 }
}
