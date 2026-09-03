/**
 * workspace-scope.ts — P3-C (production ScopeKeyResolver).
 *
 * Maps runtime context → opaque ScopeKey using workspace:v1 algorithm:
 *   ctx.cwd → path.resolve (absolute) → realpath (canonical) →
 *   SHA-256 UTF-8 → "workspace:v1:" + hex digest → ScopeKey
 *
 * Production export surface (deliberately minimal):
 *   - createWorkspaceScopeKeyResolver()
 *   - ScopeResolutionError
 *   - WORKSPACE_SCOPE_VERSION
 *
 * Module invariants (P3-C LOCK):
 *   1. Durable identity derives from ctx.cwd ONLY (LOCK §1-3).
 *   2. ctx.cwd canonicalized via path.resolve + realpath (LOCK §4-5).
 *   3. No .git / .pi / package.json upward discovery (LOCK §6).
 *   4. ScopeKey contains no raw cwd (LOCK §7-8).
 *   5. Workspace algorithm version (v1) independent of schemaVersion.
 *   6. Resolution failure fails closed (LOCK §12, no fallback).
 *   7. No runtime session identity read (LOCK §13).
 *   8. Single production resolver, no framework (LOCK §14-16).
 *   9. No state cache / no second authority (LOCK §17).
 *  10. No CLI UX / no journal / no replay.
 *  11. ScopeKey construction is module-private (LOCK §21). The ONLY
 *      production path that mints a Workspace ScopeKey is
 *      createWorkspaceScopeKeyResolver().resolve(ctx).
 *  12. Internal canonicalization / hashing helpers are NOT exported
 *      (LOCK §22). Tests must exercise them through the public
 *      resolver or via direct internal calls (test-only).
 *  13. workspace:v1 identity is location-based (LOCK §25).
 *      Moving/renaming a workspace directory produces a different
 *      ScopeKey. P3-C performs no automatic scope relocation.
 *      Path-based identity is intentional and deterministic.
 */

import { realpath } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { createHash } from "node:crypto";

import type { ScopeKey, ScopeKeyResolver } from "./persistence-contract.ts";

// ── Workspace algorithm version (LOCK §7-9) ───────────────────────────

/** Workspace scope algorithm version. Independent of schemaVersion. */
export const WORKSPACE_SCOPE_VERSION = 1 as const;

// ── Error model (LOCK §10-11) ───────────────────────────────────────────

/**
 * Infrastructure failure for scope resolution. NOT a CLI UX string.
 * Presentation belongs to P3-E.
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

// ── Internal helpers (LOCK §11, §22: module-private) ──────────────────
//
// These helpers are NOT exported. The only production ScopeKey minting
// path is createWorkspaceScopeKeyResolver().resolve(ctx). Tests may
// re-import them via internal test surface, but production code must
// not reach them directly.

/** Canonicalize cwd: absolute + realpath. Throws ScopeResolutionError. */
async function resolveCanonicalWorkspacePath(cwd: string): Promise<string> {
 if (typeof cwd !== "string" || cwd.length === 0) {
  throw new ScopeResolutionError("cwd is missing or empty");
 }
 const absolute = pathResolve(cwd);
 try {
  return await realpath(absolute);
 } catch (cause) {
  throw new ScopeResolutionError(`realpath failed for ${cwd}`, cause);
 }
}

/** Hash a canonical workspace path to a branded ScopeKey. */
function scopeKeyFromCanonicalWorkspacePath(canonicalPath: string): ScopeKey {
 const digest = createHash("sha256")
  .update(canonicalPath, "utf8")
  .digest("hex");
 return `workspace:v${WORKSPACE_SCOPE_VERSION}:${digest}` as ScopeKey;
}

// ── Production resolver (LOCK §14-16) ──────────────────────────────────

/**
 * Production ScopeKeyResolver. v0 algorithm (LOCK §4):
 *
 *   1. read ctx.cwd
 *   2. path.resolve → absolute
 *   3. realpath → canonical (symlink-aware)
 *   4. SHA-256 UTF-8 → hex digest
 *   5. prefix as workspace:v1:<digest> → ScopeKey
 *
 * Returns a resolver compatible with the P3-A ScopeKeyResolver
 * interface. v0 is the single production resolver; no resolver
 * framework, no Git / package / session fallback.
 *
 * Resolution failure (missing cwd, realpath error) throws
 * ScopeResolutionError — there is no cwd-string or session-id
 * fallback (LOCK §6).
 */
export function createWorkspaceScopeKeyResolver(): ScopeKeyResolver<unknown> {
 return {
  async resolve(ctx: unknown): Promise<ScopeKey> {
   const cwd = (ctx as { cwd?: unknown } | null | undefined)?.cwd;
   if (typeof cwd !== "string" || cwd.length === 0) {
    throw new ScopeResolutionError("ctx.cwd is missing or empty");
   }
   const canonical = await resolveCanonicalWorkspacePath(cwd);
   return scopeKeyFromCanonicalWorkspacePath(canonical);
  },
 };
}
