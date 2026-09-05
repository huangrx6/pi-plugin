/**
 * mutation-selector.ts — P1-A: Selector parsing, normalization,
 * resolution, and policy validation.
 *
 * Owns the selector lifecycle:
 *   raw tokens (string[])
 *     → parseSelectorTokens()        // syntax: ids | named
 *     → normalizeSelector()          // dedupe ids (preserves order)
 *     → resolveSelectorIds(state, …) // against immutable snapshot
 *     → validateMutationCommand(cmd) // policy: named + command legality
 *
 * Module invariants (P1-A LOCKED):
 *   1. PURE READ: no state mutation, no clock, no reducer calls.
 *   2. Imports: `./types.ts` and `./projection.ts` (for canonical
 *      selectXxxTaskIds). Does NOT import `./graph.ts`, `./reducer.ts`,
 *      `./format.ts`, or `./mutation-command.ts` (file ownership).
 *   3. Named resolution MUST consume canonical projection queries
 *      (selectCompletedTaskIds / selectArchivedTaskIds / selectAllTaskIds)
 *      — never re-implement filter/sort membership logic.
 *   4. Explicit-id resolution: nonexistent AND deleted tombstone BOTH
 *      surface as `notFound`. User cannot distinguish them. formatter
 *      renders uniformly as "Task #X not found.".
 *   5. Named resolution silently excludes deleted (B3 behavior).
 *   6. Policy rejection: exactly four rejected (command, named) combos:
 *        archive archived, archive all, restore completed, restore all.
 *      All reported as SELECTOR_NOT_ALLOWED.
 *   7. resolveSelectorIds is pure read against the snapshot it receives;
 *      caller MUST pass the pre-mutation state (P1-B).
 */

import {
 selectAllTaskIds,
 selectArchivedTaskIds,
 selectCompletedTaskIds,
} from "./projection.ts";
import type {
 MutationCommand,
 MutationPolicyDecision,
 ResolveResult,
 Selector,
 TaskId,
 TaskState,
} from "./types.ts";

// ── Parse selector tokens (syntax only) ───────────────────────────────────

/**
 * Parse whitespace-split selector tokens into a typed Selector AST.
 * Returns null on syntax error.
 *
 * Accepts:
 *   - all positive integers → { kind: "ids", ids: [...] }
 *   - exactly one named keyword ("completed" | "archived" | "all")
 *     → { kind: "named", name: … }
 *
 * Rejects (returns null):
 *   - mixed tokens (some integer, some named)
 *   - multiple named tokens ("completed archived")
 *   - non-positive integers, floats, negatives, non-numeric
 *   - empty tokens array
 */
export function parseSelectorTokens(
 tokens: readonly string[],
): Selector | null {
 if (tokens.length === 0) return null;

 const integerIds: TaskId[] = [];
 let allIntegers = true;
 for (const t of tokens) {
  if (!/^\d+$/.test(t)) {
   allIntegers = false;
   break;
  }
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n <= 0) {
   allIntegers = false;
   break;
  }
  integerIds.push(n);
 }

 if (allIntegers) return { kind: "ids", ids: integerIds };

 // Single named keyword.
 if (tokens.length === 1) {
  const name = tokens[0];
  if (name === "completed" || name === "archived" || name === "all") {
   return { kind: "named", name };
  }
 }
 return null;
}

// ── Normalize (dedupe preserving first occurrence) ──────────────────────────

/** Normalize a selector: dedupe ids preserving first occurrence.
 *  Named selectors returned unchanged. */
export function normalizeSelector(selector: Selector): Selector {
 if (selector.kind !== "ids") return selector;
 const seen = new Set<TaskId>();
 const ids: TaskId[] = [];
 for (const id of selector.ids) {
  if (!seen.has(id)) {
   seen.add(id);
   ids.push(id);
  }
 }
 return { kind: "ids", ids };
}

// ── Resolve (against immutable snapshot) ──────────────────────────────────

/**
 * Resolve selector → target ids against an IMMUTABLE state snapshot.
 *
 * - named "completed" → selectCompletedTaskIds(state)
 * - named "archived"  → selectArchivedTaskIds(state)
 * - named "all"       → selectAllTaskIds(state)
 * - ids               → dedupe; missing OR deleted tombstone → notFound
 *   (user cannot distinguish; formatter renders uniformly).
 *
 * Named resolution silently excludes deleted (canonical B3 behavior).
 */
export function resolveSelectorIds(
 state: TaskState,
 selector: Selector,
): ResolveResult {
 if (selector.kind === "named") {
  if (selector.name === "completed") {
   return { ok: true, ids: selectCompletedTaskIds(state) };
  }
  if (selector.name === "archived") {
   return { ok: true, ids: selectArchivedTaskIds(state) };
  }
  // "all"
  return { ok: true, ids: selectAllTaskIds(state) };
 }

 // ids selector: explicit IDs
 const seen = new Set<TaskId>();
 const resolved: TaskId[] = [];
 const notFound: TaskId[] = [];

 for (const id of selector.ids) {
  if (seen.has(id)) continue;
  seen.add(id);

  const task = state.tasks.find((t) => t.id === id);
  if (!task) {
   // nonexistent explicit id
   notFound.push(id);
   continue;
  }
  if (task.status === "deleted") {
   // deleted tombstone — surface as notFound (user can't distinguish).
   notFound.push(id);
   continue;
  }
  resolved.push(id);
 }

 return notFound.length > 0
  ? { ok: false, notFound }
  : { ok: true, ids: resolved };
}

// ── Validate (selector × command policy) ──────────────────────────────────

/**
 * Mutation selector policy. Called AFTER parseMutationCommand +
 * parseSelectorTokens + normalizeSelector + resolveSelectorIds.
 *
 * Policy matrix (P1 v0 LOCKED):
 * Command    IDs    completed    archived    all
 * archive    ✅    ✅           ❌          ❌
 * restore    ✅    ❌           ✅          ❌
 *
 * The 4 rejected combos all surface as SELECTOR_NOT_ALLOWED. Explicit
 * ID lifecycle status (e.g. "is #17 archived?") is NOT a policy
 * concern — that's the reducer's domain precondition, NOT P1's.
 */
export function validateMutationCommand(
 command: MutationCommand,
): MutationPolicyDecision {
 if (
  command.kind === "start" ||
  command.kind === "finish" ||
  command.kind === "reopen" ||
  command.kind === "close"
 ) {
  return { ok: true };
 }

 // archive / restore — only named selectors can be policy-rejected.
 const sel = command.selector;
 if (sel.kind === "named") {
  const disallowed = sel.name === "archived" || sel.name === "all";
  const disallowedRestore = sel.name === "completed" || sel.name === "all";

  if (command.kind === "archive" && disallowed) {
   return {
    ok: false,
    error: {
     code: "SELECTOR_NOT_ALLOWED",
     command: "archive",
     selector: sel.name,
    },
   };
  }
  if (command.kind === "restore" && disallowedRestore) {
   return {
    ok: false,
    error: {
     code: "SELECTOR_NOT_ALLOWED",
     command: "restore",
     selector: sel.name,
    },
   };
  }
 }
 return { ok: true };
}

// ── End-to-end convenience: parse raw tokens → resolve against snapshot ─

/** Convenience wrapper: parseSelectorTokens + normalizeSelector.
 *  Used by the P1-D dispatcher after parseMutationCommand. */
export function parseAndNormalizeSelector(
 tokens: readonly string[],
): { ok: true; selector: Selector } | { ok: false; error: "SYNTAX" } {
 const parsed = parseSelectorTokens(tokens);
 if (parsed === null) return { ok: false, error: "SYNTAX" };
 return { ok: true, selector: normalizeSelector(parsed) };
}
