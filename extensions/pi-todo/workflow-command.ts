/**
 * workflow-command.ts — P4-C2 (workflow command grammar).
 *
 * Recognizes the additive P4 workflow verb `here`. Does NOT modify or
 * shadow any P0–P3 command parser (`parseMutationCommand`,
 * `parseGraphCommand`, `parseTodosCommand`).
 *
 * Module invariants (P4-C2 LOCK 15, 23):
 *   1. Recognizes exactly one workflow verb: `here`. No other tokens.
 *   2. `here` accepts exactly zero arguments. Extra tokens are a
 *      syntax error (never silently dropped).
 *   3. Case variants (`HERE`, `Here`) are recognized as the same verb
 *      but produce a syntax error, matching the P2-C precedent for
 *      "known verb with wrong case → recognized intent → syntax-error".
 *   4. Three-state result: `command` / `syntax-error` /
 *      `not-workflow-command`. The third state lets the B3 fallthrough
 *      handle all other tokens.
 *   5. Contains no UX strings. Wording for the syntax error lives in
 *      `workflow-format.ts` (LOCK 30).
 */

export type WorkflowCommand = { kind: "here" };

export type ParseWorkflowCommandResult =
 | { kind: "command"; command: WorkflowCommand }
 | { kind: "syntax-error"; verb: "here" }
 | { kind: "not-workflow-command" };

export function parseWorkflowCommand(raw: unknown): ParseWorkflowCommandResult {
 const tokens = String(raw ?? "")
  .trim()
  .split(/\s+/)
  .filter((t) => t !== "");
 if (tokens.length === 0) {
  return { kind: "not-workflow-command" };
 }
 const first = tokens[0]!;
 if (first === "here") {
  if (tokens.length > 1) {
   return { kind: "syntax-error", verb: "here" };
  }
  return { kind: "command", command: { kind: "here" } };
 }
 // Case variant: known verb but wrong case → syntax-error (P2-C
 // precedent for "recognized intent, wrong grammar").
 if (first.toLowerCase() === "here") {
  return { kind: "syntax-error", verb: "here" };
 }
 return { kind: "not-workflow-command" };
}
