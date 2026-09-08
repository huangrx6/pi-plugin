/**
 * persistence-format.ts — P3-E (infrastructure UX only).
 *
 * Formats ONLY scope / persistence / CAS failure surfaces to the CLI.
 * NEVER overrides P1-C 5-layer domain / selector / graph error UX.
 *
 * Module invariants (P3-E LOCK):
 *   1. Every P3-B PersistenceError variant has an explicit P3-E mapping.
 *   2. User-facing wording is stable; debug cause is kept in error
 *      channels, not user-facing lines.
 *   3. No CLI / domain / selector / graph error UX lives here.
 */

import type { ScopeResolutionError } from "./session-scope.ts";

/**
 * P3-E infrastructure surface. Distinct from:
 * - MutationCliError (P1-C, 5-layer domain / selector / graph)
 * - ReplayIntegrityError (P3-D, reconstruction)
 * - ScopeResolutionError (raw resolver failure)
 */
export type InfrastructureNotice =
 | { kind: "cas-conflict"; actualRevision: number }
 | { kind: "scope-resolution-failure"; message: string }
 | { kind: "corrupt-snapshot" }
 | { kind: "unsupported-schema"; schemaVersion: number }
 | { kind: "migration-failure"; fromVersion: number }
 | { kind: "io-failure" };

/**
 * Stable, user-facing wording for P3-E infrastructure surfaces. The
 * underlying error / cause is intentionally NOT surfaced to the CLI
 * to avoid leaking filesystem or schema internals.
 */
export function formatInfrastructureNotice(n: InfrastructureNotice): string {
 switch (n.kind) {
  case "cas-conflict":
   return `Todo write NOT applied: the shared todo store moved to revision ${n.actualRevision} (another process on this session committed first; the store is safe). Re-issue the same todo command to apply it.`;
  case "scope-resolution-failure":
   return `Unable to resolve the current todo scope: ${n.message}`;
  case "corrupt-snapshot":
   return "Todo storage is corrupted. No changes were made.";
  case "unsupported-schema":
   return `Todo data uses an unsupported schema version (${n.schemaVersion}).`;
  case "migration-failure":
   return `Todo data uses an unsupported schema version (${n.fromVersion}).`;
  case "io-failure":
   return "Unable to access todo storage. No changes were saved.";
 }
}

/** Map a raw ScopeResolutionError into the P3-E infrastructure union. */
export function scopeResolutionToNotice(
 cause: ScopeResolutionError,
): InfrastructureNotice {
 return { kind: "scope-resolution-failure", message: cause.message };
}
