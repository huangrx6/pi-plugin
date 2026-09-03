/**
 * selector-policy-notice.ts — P4-C2 (selector rejection wording).
 *
 * Owns the user-visible explanation for selector-policy rejections
 * emitted by frozen `validateMutationCommand` (P1-A). The policy is
 * FROZEN; only the wording is mutable here. This module does NOT
 * touch any other P1 error kind (command-syntax / selector-syntax /
 * resolution / domain) — those continue to use frozen
 * `formatMutationError`.
 *
 * Module invariants (P4-C2 LOCK 21, 22, 29):
 *   1. Consumes the narrow `MutationUsageError` shape from P1-A.
 *      Does NOT import or re-implement `MutationError` /
 *      `MutationCliError` unions.
 *   2. Architecture direction: mutation-selector.ts (validation) →
 *      formatSelectorPolicyNotice (presentation). Never reversed —
 *      `mutation-selector.ts` MUST NOT import this module. This
 *      lock is verified by source-inspection test in
 *      `selector-policy-notice.test.ts`.
 *   3. Each rejection maps to actionable text — explains WHY the
 *      selector is rejected, not just THAT it is rejected.
 *   4. The frozen policy (`{command, selector}` rejection set) is
 *      unchanged. The validator oracle test in the test file
 *      confirms upstream validation still rejects the same inputs.
 */

import type { MutationUsageError } from "./types.ts";

export function formatSelectorPolicyNotice(
 error: MutationUsageError,
): string[] {
 // `code` is the only discriminator in the frozen P1-A error shape;
 // switch exhaustively on it so future error codes are caught at
 // compile time.
 switch (error.code) {
  case "SELECTOR_NOT_ALLOWED": {
   const verb = error.command;
   const sel = error.selector;
   if (verb === "archive" && sel === "all") {
    return [
     "`all` cannot be used with `archive` because already-archived tasks",
     "are outside the archive target set.",
     "",
     "Use task IDs or `completed`.",
    ];
   }
   if (verb === "archive" && sel === "archived") {
    return [
     "`archived` cannot be used with `archive` because those tasks",
     "are already archived.",
     "",
     "Use task IDs or `completed`.",
    ];
   }
   if (verb === "restore" && sel === "completed") {
    return [
     "`completed` cannot be used with `restore` because completed tasks",
     "are not archived (only archived tasks can be restored).",
     "",
     "Use task IDs or `archived`.",
    ];
   }
   if (verb === "restore" && sel === "all") {
    return [
     "`all` cannot be used with `restore` because the restore target",
     "set is archived tasks only.",
     "",
     "Use task IDs or `archived`.",
    ];
   }
   // Defensive fallback: the four rejected (command, selector) pairs
   // are pinned by P1-A. If a new pair is added, this branch is hit
   // intentionally so the architecture lock forces an update here.
   return [
    `\`${sel}\` is not a valid selector for \`${verb}\`.`,
    "Use task IDs or `completed`/`archived`.",
   ];
  }
 }
}
