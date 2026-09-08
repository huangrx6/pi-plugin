/**
 * session-scope.ts — production ScopeKeyResolver (session:v1).
 *
 * Maps runtime context → opaque ScopeKey using session:v1 algorithm:
 *   ctx.sessionManager.getSessionId() → SHA-256 UTF-8 →
 *   "session:v1:" + hex digest → ScopeKey
 *
 * Production export surface (deliberately minimal):
 *   - createSessionScopeKeyResolver()
 *   - ScopeResolutionError
 *   - SESSION_SCOPE_VERSION
 *
 * Module invariants (LOCK):
 *   1. Durable identity derives from ctx.sessionManager.getSessionId()
 *      ONLY. One session owns one todo list; concurrent sessions in
 *      the same directory are isolated by design.
 *   2. ctx.cwd is NEVER read. No location / workspace identity.
 *   3. ScopeKey contains no raw session id (SHA-256 hex only).
 *   4. Session algorithm version (v1) independent of schemaVersion.
 *   5. Resolution failure fails closed (no fallback, no anonymous
 *      shared scope).
 *   6. Single production resolver, no framework.
 *   7. No state cache / no second authority.
 *   8. No CLI UX / no journal / no replay.
 *   9. ScopeKey construction is module-private. The ONLY production
 *      path that mints a session ScopeKey is
 *      createSessionScopeKeyResolver().resolve(ctx).
 *  10. Session identity is lifetime-based, not location-based.
 *      Moving or renaming the workspace directory does NOT change
 *      the ScopeKey; the todo list follows the conversation, not
 *      the directory.
 */

import { createHash } from "node:crypto";

import type { ScopeKey, ScopeKeyResolver } from "./persistence-contract.ts";

// ── Session algorithm version ───────────────────────────────────────────

/** Session scope algorithm version. Independent of schemaVersion. */
export const SESSION_SCOPE_VERSION = 1 as const;

// ── Error model ──────────────────────────────────────────────────────────

/**
 * Infrastructure failure for scope resolution. NOT a CLI UX string.
 * Presentation belongs to the notice formatter.
 */
export class ScopeResolutionError extends Error {
 readonly kind = "scope-resolution" as const;
 constructor(
  message: string,
  readonly cause?: unknown,
 ) {
  super(message);
  this.name = "ScopeResolutionError";
 }
}

// ── Internal helpers (module-private) ────────────────────────────────────
//
// Not exported. The only production ScopeKey minting path is
// createSessionScopeKeyResolver().resolve(ctx).

/** Hash a session id to a branded ScopeKey. */
function scopeKeyFromSessionId(sessionId: string): ScopeKey {
 const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
 return `session:v${SESSION_SCOPE_VERSION}:${digest}` as ScopeKey;
}

/** Extract and validate the runtime session id from ctx. */
function sessionIdFromCtx(ctx: unknown): string {
 const sid = (
  ctx as
   | { sessionManager?: { getSessionId?: () => unknown } }
   | null
   | undefined
 )?.sessionManager?.getSessionId?.();
 if (typeof sid !== "string" || sid.length === 0) {
  throw new ScopeResolutionError(
   "ctx.sessionManager.getSessionId() is missing, empty, or not a string",
  );
 }
 return sid;
}

// ── Production resolver ──────────────────────────────────────────────────

/**
 * Production ScopeKeyResolver (session:v1):
 *
 *   1. read ctx.sessionManager.getSessionId()
 *   2. validate non-empty string
 *   3. SHA-256 UTF-8 → hex digest
 *   4. prefix as session:v1:<digest> → ScopeKey
 *
 * Returns a resolver compatible with the ScopeKeyResolver interface.
 * Resolution failure (missing session id) throws
 * ScopeResolutionError — there is no cwd or anonymous fallback.
 */
export function createSessionScopeKeyResolver(): ScopeKeyResolver<unknown> {
 return {
  async resolve(ctx: unknown): Promise<ScopeKey> {
   return scopeKeyFromSessionId(sessionIdFromCtx(ctx));
  },
 };
}
