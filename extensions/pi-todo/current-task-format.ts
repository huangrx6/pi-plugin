/**
 * current-task-format.ts — P4-C2 (`/todos here` formatter).
 *
 * Renders the workflow-recovery view: which task is the user
 * currently working on, and what would its completion directly
 * unlock. Reads state + width → string[]. Composes frozen P0-B /
 * P2-A / P2-B formatters and queries — does NOT re-implement any
 * dependency / readiness semantic.
 *
 * Layer chain:
 *   projection (P0-B) →
 *   queryNextTasks / queryUnlocksTask (P2-A) →
 *   formatNextTasks / formatUnlocksTask / formatTaskRow (P2-B / P0-B)
 *   → current-task-format (P4-C2)
 *
 * Module invariants (P4-C2 LOCK 1–10, 16, 17, 22, 24):
 *   1. `/todos here` is read-only. The module never mutates state.
 *   2. RUNNING and BLOCKED are mutually exclusive frozen roles
 *      (P2-B). P4-C2 does not invent a "blocked running" state
 *      (LOCK 16, 17) — RUNNING outputs never include a
 *      `Blocked by:` section.
 *   3. RUNNING=0 summary uses frozen `formatNextTasks` output
 *      verbatim — no double `Next:` header (LOCK 24).
 *   4. Direct unlocks only via frozen `queryUnlocksTask` +
 *      `formatUnlocksTask`. No transitive traversal (LOCK 9).
 *   5. RUNNING=0 "Next:" summary is verbatim frozen result, not
 *      a P4 recommendation (LOCK 22).
 *   6. RUNNING>1 displays all running tasks; no "anomaly" claim
 *      (LOCK 10).
 */

import { formatTaskRow } from "./format.ts";
import { projectActiveView } from "./projection.ts";
import { queryNextTasks, queryUnlocksTask } from "./graph-query.ts";
import { formatNextTasks, formatUnlocksTask } from "./graph-format.ts";
import type { TaskState } from "./types.ts";

/** Indent for the per-task sections when RUNNING > 1. */
const SECTION_INDENT = "  ";

export function formatCurrentTask(state: TaskState, width: number): string[] {
 const view = projectActiveView(state);
 const running = view.running;

 // ── RUNNING = 0 ─────────────────────────────────────────────────
 if (running.length === 0) {
  const next = queryNextTasks(state);
  if (next.tasks.length === 0) {
   return ["No task is currently running."];
  }
  // C24: embed `formatNextTasks` output verbatim — it owns its own
  // "Next:" section header.
  return ["No task is currently running.", "", ...formatNextTasks(next, width)];
 }

 // ── RUNNING = 1 ─────────────────────────────────────────────────
 if (running.length === 1) {
  const task = running[0]!;
  const lines: string[] = ["Current:"];
  const unlocks = queryUnlocksTask(state, task.id);
  if (unlocks.kind === "unlocks" && unlocks.unlocks.length > 0) {
   // formatUnlocksTask's first line is the head (canonical task row).
   // Using it preserves C20: no P4 re-render of the canonical row.
   lines.push(...formatUnlocksTask(unlocks, width));
  } else {
   lines.push(formatTaskRow(task, { role: "running", width }));
  }
  return lines;
 }

 // ── RUNNING > 1 ────────────────────────────────────────────────
 const lines: string[] = [`Current: ${running.length} running`, ""];
 for (const task of running) {
  // Indent the task row under the "Current: N running" header.
  lines.push(
   SECTION_INDENT +
    formatTaskRow(task, {
     role: "running",
     width: Math.max(1, width - SECTION_INDENT.length),
    }),
  );
  const unlocks = queryUnlocksTask(state, task.id);
  if (unlocks.kind === "unlocks" && unlocks.unlocks.length > 0) {
   const unlocksLines = formatUnlocksTask(unlocks, width);
   // Drop the head (line 0) since we already rendered the task row,
   // then indent the rest by SECTION_INDENT to nest under the row.
   for (const line of unlocksLines.slice(1)) {
    lines.push(SECTION_INDENT + line);
   }
  }
  lines.push("");
 }
 while (lines.length > 0 && lines[lines.length - 1] === "") {
  lines.pop();
 }
 return lines;
}
