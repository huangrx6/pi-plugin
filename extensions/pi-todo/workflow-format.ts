/**
 * workflow-format.ts — P4-C2 (workflow UX formatter).
 *
 * Owns the user-visible wording for workflow command paths. Currently
 * just the `here` syntax error; future P4 workflow verbs can add cases
 * here without touching `index.ts`.
 *
 * Module invariants (P4-C2 LOCK 30):
 *   1. Owns ALL workflow-syntax UX strings.
 *   2. Pure: takes a frozen verb discriminator, returns the wording.
 *   3. No imports from index.ts, no P0–P3 frozen module imports.
 */

export type WorkflowSyntaxErrorVerb = "here";

export function formatWorkflowSyntaxError(
 verb: WorkflowSyntaxErrorVerb,
): string {
 switch (verb) {
  case "here":
   return "/todos here takes no arguments.";
 }
}
