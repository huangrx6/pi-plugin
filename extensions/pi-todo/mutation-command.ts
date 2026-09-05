/**
 * mutation-command.ts — P1-A: Mutation Command grammar + parser.
 *
 * Pure syntax layer. Does NOT enforce selector policy
 * (see mutation-selector.ts → validateMutationCommand).
 * Does NOT inspect task state or call the reducer.
 *
 * Grammar (LOCKED P1 v0):
 *   start  <single-positive-safe-integer>
 *   finish <single-positive-safe-integer>
 *   reopen <single-positive-safe-integer>
 *   close  <single-positive-safe-integer>
 *   archive <selector-tokens>
 *   restore <selector-tokens>
 *
 * Anything else → { ok: false, error: "SYNTAX" }.
 *
 * Module invariants:
 *   1. PURE SYNTAX: no state read, no policy check, no projection read.
 *      Only depends on ./types.ts (no other internal modules).
 *   2. EXACT-LOWERCASE keywords (case-sensitive).
 *   3. WHITESPACE separator (split on /\s+/); commas NOT supported.
 *   4. Single-id lifecycle: extra args → SYNTAX.
 *   5. Archive/restore: at least 1 selector token required.
 *   6. ID format: positive safe integer (Number.isSafeInteger + > 0).
 *      `0012` accepted as 12; `-5` / `0` / `1.5` / `abc` rejected.
 *   7. Returns `"SYNTAX"` error (single code) for any grammar violation.
 *   8. Selector body for archive/restore is returned as `rawTokens`
 *      (an intermediate). The P1-D orchestrator hands those tokens
 *      to mutation-selector.parseSelectorTokens for typed Selector
 *      parsing. This keeps mutation-command independent of
 *      mutation-selector (file ownership LOCKED).
 */

import type { TaskId } from "./types.ts";

/** Grammar violation (single code). */
export type ParseResult =
 | { ok: true; command: ParsedCommand }
 | { ok: false; error: "SYNTAX" };

/**
 * Parsed command AST. Lifecycle commands carry their resolved id;
 * archive/restore carry raw selector tokens pending mutation-selector.
 * Use `isLifecycle` / `isArchiveRestore` to discriminate.
 */
export type ParsedCommand = LifecycleCommand | ArchiveRestoreCommand;

export type LifecycleCommand =
 | { kind: "start"; id: TaskId }
 | { kind: "finish"; id: TaskId }
 | { kind: "reopen"; id: TaskId }
 | { kind: "close"; id: TaskId };

export type ArchiveRestoreCommand =
 | { kind: "archive"; rawTokens: readonly string[] }
 | { kind: "restore"; rawTokens: readonly string[] };

/** Type guards. */
export function isLifecycle(c: ParsedCommand): c is LifecycleCommand {
 return c.kind === "start" || c.kind === "finish" || c.kind === "reopen" || c.kind === "close";
}

export function isArchiveRestore(c: ParsedCommand): c is ArchiveRestoreCommand {
 return c.kind === "archive" || c.kind === "restore";
}

/**
 * Parse raw CLI args into a ParsedCommand AST or a SYNTAX error.
 * Tokenizes on whitespace; command keyword must match exactly.
 *
 * @example
 *   parseMutationCommand("start 12")
 *     → { ok: true, command: { kind: "start", id: 12 } }
 *   parseMutationCommand("archive completed")
 *     → { ok: true, command: { kind: "archive", rawTokens: ["completed"] } }
 *   parseMutationCommand("restore 12 18 21")
 *     → { ok: true, command: { kind: "restore", rawTokens: ["12","18","21"] } }
 *   parseMutationCommand("start")
 *     → { ok: false, error: "SYNTAX" }
 */
export function parseMutationCommand(raw: string): ParseResult {
 const tokens = String(raw ?? "")
  .trim()
  .split(/\s+/)
  .filter((t) => t.length > 0);
 if (tokens.length === 0) return { ok: false, error: "SYNTAX" };

 const verb = tokens[0];
 const args = tokens.slice(1);

 switch (verb) {
  case "start":
  case "finish":
  case "reopen":
  case "close": {
   if (args.length !== 1) return { ok: false, error: "SYNTAX" };
   const id = parsePositiveSafeInteger(args[0]);
   if (id === null) return { ok: false, error: "SYNTAX" };
   return { ok: true, command: { kind: verb, id } };
  }

  case "archive":
  case "restore": {
   if (args.length === 0) return { ok: false, error: "SYNTAX" };
   return { ok: true, command: { kind: verb, rawTokens: args } };
  }

  default:
   return { ok: false, error: "SYNTAX" };
 }
}

/**
 * Parse a single token as a positive safe integer.
 * Returns null on syntax error. Accepts `0012` as 12 (Number drops
 * leading zeros); rejects "-5", "0", "1.5", "abc", huge numbers.
 */
function parsePositiveSafeInteger(token: string): TaskId | null {
 if (!/^\d+$/.test(token)) return null;
 const n = Number(token);
 if (!Number.isSafeInteger(n) || n <= 0) return null;
 return n;
}
