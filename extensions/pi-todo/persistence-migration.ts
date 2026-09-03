/**
 * persistence-migration.ts — P3-B.2 (version migration).
 *
 * v0 only supports schemaVersion=1 (identity migration). Older /
 * future versions fail closed per P3-B LOCK §7-8.
 *
 * Module invariants:
 *   1. Pure / deterministic / versioned.
 *   2. Migration preserves revision (P3-A LOCK §7).
 *   3. Migration performs NO durable writes (P3-B LOCK §7).
 *   4. No domain repair / no cross-field inference.
 */

import type { PersistenceError } from "./persistence-error.ts";
import {
 CURRENT_SCHEMA_VERSION,
 type CurrentPersistedTodoEnvelope,
 type PersistedTodoEnvelope,
} from "./persistence-contract.ts";

export type MigrationResult =
 | { readonly kind: "ok"; readonly envelope: CurrentPersistedTodoEnvelope }
 | { readonly kind: "unsupported-future"; readonly foundVersion: number }
 | { readonly kind: "unsupported-past"; readonly foundVersion: number };

/**
 * Migrate any persisted envelope (typed with known version) to the
 * current schema. v0: identity for schemaVersion=1; reject others.
 */
export function migrateToCurrent<V extends number>(
 envelope: PersistedTodoEnvelope<V>,
): MigrationResult {
 const v = envelope.schemaVersion;
 if (v === CURRENT_SCHEMA_VERSION) {
  // SAFETY: PersistedTodoEnvelope<V> for V = CURRENT_SCHEMA_VERSION
  // is structurally identical to CurrentPersistedTodoEnvelope. The
  // runtime schemaVersion check above is authoritative — when v
  // equals CURRENT, the runtime object satisfies the CURRENT-typed
  // contract. TypeScript cannot unify the generic V with the literal
  // CURRENT_SCHEMA_VERSION at the type level.
  return {
   kind: "ok",
   envelope: envelope as unknown as CurrentPersistedTodoEnvelope,
  };
 }
 if (v > CURRENT_SCHEMA_VERSION) {
  return { kind: "unsupported-future", foundVersion: v };
 }
 return { kind: "unsupported-past", foundVersion: v };
}

/**
 * Adapter: turn an unsupported-future / unsupported-past verdict
 * into a PersistenceError (used by store backends to surface the
 * failure to callers).
 */
export function migrationVerdictToError(
 result: Extract<
  MigrationResult,
  { kind: "unsupported-future" | "unsupported-past" }
 >,
): PersistenceError {
 return {
  kind: "unsupported-schema",
  schemaVersion: result.foundVersion,
 };
}
