/**
 * mutation-format.ts — P1-C (outcome formatting).
 *
 * Formats MutationOutcome into human-readable CLI output.
 *
 * Module invariants (P1-C LOCK):
 *   1. NEVER receives prev/next TaskState. Only MutationOutcome + width.
 *   2. NEVER imports graph.ts / projection.ts / reducer.ts / store.ts /
 *      read-model.ts / mutation-command.ts / mutation-selector.ts /
 *      mutation-executor.ts.
 *   3. Target role for primary receipt comes from outcome.targets
 *      (built by classifyTask in the outcome layer). NOT inferred from
 *      command kind. Especially `reopen` does NOT imply BLOCKED.
 *   4. Secondary consequences are diff-derived. Primary targets are
 *      excluded AFTER the complete diff is produced (so diff is general).
 *   5. Consequence filtering preserves ActiveViewDiff canonical order.
 *   6. No persistence, no reducer execution, no projection read.
 *   7. Formats all 5 upstream error layers without re-validating.
 *   8. Empty named selector (targetIds.length === 0 on archive/restore)
 *      renders as "Nothing to archive." / "Nothing to restore." no-op.
 *   9. No re-sorting of consequence order.
 */

import { formatTaskRow, visibleWidth } from "./format.ts";
import type {
 CommandKind,
 MutationOutcome,
 MutationTargetPresentation,
} from "./mutation-outcome.ts";
import type {
 MutationError,
 MutationUsageError,
 Task,
 TaskId,
} from "./types.ts";

// ── Primary receipt labels ──────────────────────────────────────────────

const SINGLE_LABEL: Record<CommandKind, string> = {
 start: "Started:",
 finish: "Finished:",
 reopen: "Reopened:",
 archive: "Archived:",
 restore: "Restored:",
};

const BATCH_LABEL: Record<CommandKind, string> = {
 start: "Started",
 finish: "Finished",
 reopen: "Reopened",
 archive: "Archived",
 restore: "Restored",
};

const EMPTY_SELECTOR_LABEL: Record<"archive" | "restore", string> = {
 archive: "Nothing to archive.",
 restore: "Nothing to restore.",
};

const USAGE_LINES: readonly string[] = [
 "Invalid mutation command.",
 "Usage: /todos start <id> | finish <id> | reopen <id>",
 "       /todos archive <ids|completed>",
 "       /todos restore <ids|archived>",
];

// ── formatMutationOutcome ──────────────────────────────────────────────

/**
 * Format a successful MutationOutcome for CLI display.
 * Pure formatter: only consumes outcome + width.
 */
export function formatMutationOutcome(
 outcome: MutationOutcome,
 width: number,
): string[] {
 const lines: string[] = [];

 // 1. Empty targetIds on archive/restore → "Nothing to ..."
 if (
  outcome.targetIds.length === 0 &&
  (outcome.commandKind === "archive" || outcome.commandKind === "restore")
 ) {
  lines.push(EMPTY_SELECTOR_LABEL[outcome.commandKind]);
  return lines;
 }

 // 2. Primary receipt
 if (outcome.targetIds.length === 1) {
  const target = outcome.targets[0] as MutationTargetPresentation;
  const label = SINGLE_LABEL[outcome.commandKind];
  const rowWidth = Math.max(1, width - visibleWidth(label) - 1);
  lines.push(formatSingleReceipt(label, target, rowWidth));
 } else if (outcome.targetIds.length > 1) {
  const label = BATCH_LABEL[outcome.commandKind];
  lines.push(`${label} ${outcome.targetIds.length} tasks.`);
 }

 // 3. Secondary consequences (filtered by primary exclusion).
 // The exclusion is applied AFTER the complete diff is produced so
 // the diff remains a general primitive.
 const primaryIds = new Set<TaskId>(outcome.targetIds);
 const newlyReady = outcome.diff.becameReady.filter(
  (t) => !primaryIds.has(t.id),
 );
 const reblocked = outcome.diff.becameBlocked.filter(
  (t) => !primaryIds.has(t.id),
 );

 if (newlyReady.length > 0) {
  lines.push("");
  lines.push("Now ready");
  for (const t of newlyReady) {
   lines.push(
    formatTaskRow(t, {
     role: "ready",
     width: width - 2,
    }),
   );
  }
 }

 if (reblocked.length > 0) {
  lines.push("");
  lines.push("Re-blocked");
  for (const t of reblocked) {
   lines.push(
    formatTaskRow(t, {
     role: "blocked",
     width: width - 2,
     dependencies: outcome.depsMap.get(t.id),
    }),
   );
  }
 }

 return lines;
}

/** Render a single-target primary receipt row (label + formatted row). */
function formatSingleReceipt(
 label: string,
 target: MutationTargetPresentation,
 rowWidth: number,
): string {
 // Construct a minimal Task shape for formatTaskRow. We pass only the
 // fields it actually reads (id, subject). Cast keeps the type clean.
 const synthetic = {
  id: target.id,
  subject: target.subject,
  status: target.status,
  createdAt: 0,
  updatedAt: 0,
 } as Task;
 const row = formatTaskRow(synthetic, {
  role: target.role,
  width: rowWidth,
 });
 return `${label} ${row}`;
}

// ── formatMutationError (5-layer CLI error rendering) ─────────────────────

/** CLI error union (presentation-only; orchestrator maps upstream errors here). */
export type MutationCliError =
 | { kind: "command-syntax" }
 | { kind: "selector-syntax"; command: "archive" | "restore" }
 | { kind: "selector-policy"; error: MutationUsageError }
 | { kind: "resolution"; notFound: readonly TaskId[] }
 | {
    kind: "domain";
    error: MutationError;
    failedTargetId: TaskId;
   };

/**
 * Format a CLI error. Pure presentation — does NOT parse, validate, or
 * inspect domain mutation rules. Each kind maps to a stable text template.
 */
export function formatMutationError(error: MutationCliError): string[] {
 switch (error.kind) {
  case "command-syntax":
   return [...USAGE_LINES];

  case "selector-syntax":
   return [
    `Invalid ${error.command} selector.`,
    "Use task IDs or `completed`/`archived`.",
   ];

  case "selector-policy": {
   const { command, selector } = error.error;
   return [
    `\`${selector}\` is not a valid selector for \`${command}\`.`,
    ...USAGE_LINES,
   ];
  }

  case "resolution": {
   const ids = error.notFound.map((id) => `#${id}`).join(", ");
   return [`Task ${ids} not found.`];
  }

  case "domain":
   // The P1-B executor already attaches a structured MutationError
   // (via applyTaskMutation). P1-C translates it to a one-line notice.
   return [translateDomainError(error.error)];
 }
}

/** Translate a MutationError (P0-A domain) to a single human-readable line. */
function translateDomainError(error: MutationError): string {
 switch (error.code) {
  case "SUBJECT_REQUIRED":
   return "subject required for create";
  case "ID_REQUIRED":
   return "id required for this action";
  case "TASK_NOT_FOUND":
   return `#${error.id} not found`;
  case "DEPENDENCY_NOT_FOUND":
   return `dependency #${error.depId} not found`;
  case "DEPENDENCY_DELETED":
   return `dependency #${error.depId} is deleted (cannot be a dependency)`;
  case "DEPENDENCY_SELF":
   return `#${error.depId} cannot block on itself`;
  case "DEPENDENCY_CYCLE":
   return "would create a dependency cycle";
  case "INVALID_TRANSITION":
   return `illegal transition ${error.from} → ${error.to}`;
  case "TOMBSTONE_IMMUTABLE":
   return `#${error.id} is deleted (tombstones are immutable)`;
  case "ALREADY_DELETED":
   return `#${error.id} is already deleted`;
  case "ALREADY_ARCHIVED":
   return `#${error.id} is already archived`;
  case "NOT_ARCHIVED":
   return `#${error.id} is not archived (use /todos archive first)`;
  case "ARCHIVE_REQUIRES_COMPLETED":
   return `#${error.id} cannot be archived (status must be completed)`;
  case "TASK_REFERENCED":
   return `#${error.id} is referenced by ${error.referencedBy
    .map((r) => `#${r}`)
    .join(", ")} (archive or remove the dependency first)`;
  case "MUTABLE_FIELDS_REQUIRED":
   return "update requires at least one mutable field";
  case "UNKNOWN_ACTION":
   return `unknown action: ${error.action}`;
 }
}
