/**
 * graph-command.ts — P2-C (read command grammar for graph queries).
 *
 * Pure lexical grammar: raw CLI args → GraphCommand | syntax-error
 * | not-graph-command. The parser does NOT execute the query, format
 * output, mutate state, or import any query / format / graph layer.
 *
 * Module invariants (P2-C LOCK):
 *   1. P2-C is pure lexical grammar only.
 *   2. P0-B parseTodosCommand remains unchanged and FROZEN. This file
 *      does not import it.
 *   3. P1 mutation-command parser remains unchanged and FROZEN. This
 *      file does not import it.
 *   4. Graph verbs have exactly one lexical source here:
 *        next | why | unlocks
 *      index.ts does not duplicate a GRAPH_VERBS set.
 *   5. parseGraphCommand returns exactly one of:
 *        command | syntax-error | not-graph-command
 *   6. Existing B3 read commands return not-graph-command and remain
 *      eligible for existing read dispatch.
 *   7. Mutation commands also return not-graph-command.
 *   8. next accepts exactly zero arguments.
 *   9. why / unlocks accept exactly one positive safe-integer TaskId.
 *  10. ID lexical policy:
 *        0012 → 12
 *        0 / -1 / +1 / 1.5 / 1e3 / non-numeric / unsafe → syntax-error
 *  11. Graph command verbs are lowercase canonical vocabulary.
 *      Case variants of graph verbs are syntax errors (not silent
 *      fall-through to read).
 *  12. P2-C performs no task lookup, graph lookup, query execution,
 *      formatting, notification, persistence, or mutation.
 *  13. P2-C emits no user-facing strings.
 *  14. GraphCommand is a discriminated union with no optional
 *      target-id state.
 *  15. P0 / P1 / P2-A / P2-B remain FROZEN.
 */

import type { TaskId } from "./types.ts";

// ── Public types ───────────────────────────────────────────────────────

/** Canonical graph verbs. Lowercase. */
export type GraphVerb = "next" | "why" | "unlocks";

/** Structured graph command. Discriminated union; no optional id. */
export type GraphCommand =
 | { readonly kind: "next" }
 | { readonly kind: "why"; readonly id: TaskId }
 | { readonly kind: "unlocks"; readonly id: TaskId };

/**
 * Three-state result. Distinguishes:
 *   - command         : valid graph command, ready for query
 *   - syntax-error    : graph verb recognized but grammar violated
 *   - not-graph-command : nothing to do with graph; fall through to B3
 */
export type ParseGraphCommandResult =
 | { readonly kind: "command"; readonly command: GraphCommand }
 | { readonly kind: "syntax-error"; readonly verb: GraphVerb }
 | { readonly kind: "not-graph-command" };

// ── Single lexical source for graph verbs ─────────────────────────────

const GRAPH_VERB_NAMES: ReadonlySet<GraphVerb> = new Set<GraphVerb>([
 "next",
 "why",
 "unlocks",
]);

// ── Public API ────────────────────────────────────────────────────────

/**
 * Parse raw CLI args into a GraphCommand, a syntax-error verdict, or
 * a not-graph-command signal that defers to the existing read dispatch.
 *
 * Case policy: verb token must be lowercase canonical. Mixed-case
 * variants (e.g. `Why 12`, `NEXT`) are syntax errors with verb
 * reported as the lowercase canonical — never silently fall through.
 *
 * Whitespace: leading / trailing / repeated whitespace is normalized;
 * an empty input is not-graph-command.
 */
export function parseGraphCommand(raw: string): ParseGraphCommandResult {
 const tokens = String(raw ?? "")
  .trim()
  .split(/\s+/)
  .filter((t) => t.length > 0);
 if (tokens.length === 0) return { kind: "not-graph-command" };

 const first = tokens[0] as string;
 const normalized = first.toLowerCase();

 // Not a graph verb at all → fall through to existing read dispatch.
 if (!isGraphVerb(normalized)) {
  return { kind: "not-graph-command" };
 }

 // Wrong case (e.g. "Why", "NEXT") → syntax error. Never silently fall
 // through; otherwise the user gets an obscure read-dispatch error.
 if (first !== normalized) {
  return { kind: "syntax-error", verb: normalized };
 }

 // Verbs are lowercase; normalized === first is now guaranteed.
 return parseGraphVerbCall(normalized, tokens);
}

// / — Internal: dispatch after verb recognition ───────────────────────

function parseGraphVerbCall(
 verb: GraphVerb,
 tokens: readonly string[],
): ParseGraphCommandResult {
 switch (verb) {
  case "next":
   if (tokens.length !== 1) {
    return { kind: "syntax-error", verb };
   }
   return { kind: "command", command: { kind: "next" } };

  case "why":
  case "unlocks": {
   if (tokens.length !== 2) {
    return { kind: "syntax-error", verb };
   }
   const id = parseTaskIdToken(tokens[1] as string);
   if (id === undefined) {
    return { kind: "syntax-error", verb };
   }
   return {
    kind: "command",
    command: { kind: verb, id },
   };
  }
 }
}

// ── Internal helpers ──────────────────────────────────────────────────

function isGraphVerb(token: string): token is GraphVerb {
 return GRAPH_VERB_NAMES.has(token as GraphVerb);
}

/**
 * Lexical TaskId parser. Pure token-level grammar; never inspects
 * state. `0012` → 12 (leading zeros accepted). `0`, negative, signed,
 * fractional, exponential, non-numeric, and unsafe integers all
 * resolve to undefined.
 */
function parseTaskIdToken(token: string): TaskId | undefined {
 if (!/^\d+$/.test(token)) return undefined;
 const id = Number(token);
 if (!Number.isSafeInteger(id) || id <= 0) return undefined;
 return id;
}
