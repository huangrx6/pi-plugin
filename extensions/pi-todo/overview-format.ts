/**
 * overview-format.ts — P4-C1 (bounded overview formatter).
 *
 * Renders a bounded overview for the default `/todos` command: each
 * section (RUNNING / READY / BLOCKED) is truncated to its per-section
 * budget with an explicit "+N more <role>" overflow hint that doubles
 * as a drill-down prompt to `/todos <section>`. Section commands
 * (`/todos ready`, `/todos blocked`, `/todos completed`, `/todos
 * archived`) continue to use frozen `formatTasksList` for full lists.
 *
 * Layer chain:
 *   projection (P0-B B1) → overview-format (P4-C1) → CLI string[]
 *
 * Module invariants (P4-C1 LOCK):
 *   1. NEVER modifies P0-B primitives (formatTaskRow / formatTaskDetail
 *      / formatTasksList / formatTodosSnapshot). Composes them only.
 *   2. Empty state semantics delegated to renderDefault's wrapper.
 *      This formatter NEVER returns "No todos." — it returns [] for
 *      fully empty views, identical to formatTodosSnapshot, so the
 *      caller can decide the user-visible wording.
 *   3. Active=0 + completedVisible>0 → completed-only behavior is
 *      EXACTLY identical to formatTodosSnapshot output (oracle-tested).
 *   4. Per-section budgets: defaults RUNNING=2, READY=3, BLOCKED=2.
 *      Caller MAY override via `options.budgets`. `budgets = undefined`
 *      and `budgets = {}` both mean "use defaults" — for full lists
 *      the caller should use the frozen formatTasksList, not this
 *      bounded formatter.
 *   5. Overflow wording: "+N more <role>" (distinct from overlay's
 *      "+N <role>" so CLI readers know it's a drill-down hint, not
 *      just a section count).
 *   6. Glyph mapping / role semantics / dependency presentation
 *      delegated entirely to formatTaskRow. No re-implementation.
 *   7. Section header preserved exactly as frozen formatter uses.
 *      ARCHIVED is NEVER in the bounded overview (per P0-B B4).
 */

import { formatTaskRow } from "./format.ts";
import type { ActiveView, Task, TaskDependencyPresentation } from "./types.ts";

export interface OverviewBudgets {
 running?: number;
 ready?: number;
 blocked?: number;
}

export interface BoundedOverviewOptions {
 width: number;
 dependencies: ReadonlyMap<number, readonly TaskDependencyPresentation[]>;
 budgets?: OverviewBudgets;
}

const DEFAULT_RUNNING_BUDGET = 2;
const DEFAULT_READY_BUDGET = 3;
const DEFAULT_BLOCKED_BUDGET = 2;

/** CLI drill-down hint prefix. Two spaces to visually align with
 *  indented task rows produced by formatTaskRow. */
const OVERFLOW_INDENT = "  ";

/**
 * Render a bounded overview ActiveView → string[]. Sections are
 * truncated to their per-section budget; the "+N more <role>" line
 * below each section signals that more rows exist and points to the
 * corresponding drill-down command.
 *
 * Returns [] when the view is fully empty (matches frozen
 * formatTodosSnapshot). The caller is responsible for translating []
 * into a user-visible "No todos." message if desired.
 */
export function formatBoundedOverview(
 view: ActiveView,
 options: BoundedOverviewOptions,
): string[] {
 const runningBudget = options.budgets?.running ?? DEFAULT_RUNNING_BUDGET;
 const readyBudget = options.budgets?.ready ?? DEFAULT_READY_BUDGET;
 const blockedBudget = options.budgets?.blocked ?? DEFAULT_BLOCKED_BUDGET;

 const lines: string[] = [];

 const header = formatOverviewHeader(view);
 if (header !== "") {
  lines.push(header);
  lines.push("");
 }

 const runningLines = renderBoundedSection(
  "RUNNING",
  view.running,
  runningBudget,
  "running",
  options.width,
  options.dependencies,
  "more running",
 );
 if (runningLines.length > 0) {
  lines.push(...runningLines);
  lines.push("");
 }

 const readyLines = renderBoundedSection(
  "READY",
  view.ready,
  readyBudget,
  "ready",
  options.width,
  options.dependencies,
  "more ready",
 );
 if (readyLines.length > 0) {
  lines.push(...readyLines);
  lines.push("");
 }

 const blockedLines = renderBoundedSection(
  "BLOCKED",
  view.blocked,
  blockedBudget,
  "blocked",
  options.width,
  options.dependencies,
  "more blocked",
 );
 if (blockedLines.length > 0) {
  lines.push(...blockedLines);
  lines.push("");
 }

 if (view.counts.completedVisible > 0) {
  lines.push(`✓ ${view.counts.completedVisible} completed · /todos completed`);
 }

 while (lines.length > 0 && lines[lines.length - 1] === "") {
  lines.pop();
 }
 return lines;
}

/** Format the "Todos · ▶N ◆M ○K · ✓C" header. Empty string when there
 *  are no active sections (so completed-only views emit no header). */
function formatOverviewHeader(view: ActiveView): string {
 const active: string[] = [];
 if (view.running.length > 0) active.push(`▶${view.running.length}`);
 if (view.ready.length > 0) active.push(`◆${view.ready.length}`);
 if (view.blocked.length > 0) active.push(`○${view.blocked.length}`);
 if (active.length === 0) return "";
 let result = `Todos · ${active.join(" ")}`;
 if (view.counts.completedVisible > 0) {
  result += ` · ✓${view.counts.completedVisible}`;
 }
 return result;
}

function renderBoundedSection(
 label: string,
 tasks: readonly Task[],
 budget: number,
 role: "running" | "ready" | "blocked",
 width: number,
 depsMap: ReadonlyMap<number, readonly TaskDependencyPresentation[]>,
 overflowSuffix: string,
): string[] {
 if (tasks.length === 0) return [];
 const lines: string[] = [];
 lines.push(label);
 const shown = tasks.slice(0, budget);
 for (const t of shown) {
  lines.push(
   formatTaskRow(t, {
    role,
    width,
    dependencies: depsMap.get(t.id),
   }),
  );
 }
 if (tasks.length > budget) {
  lines.push(`${OVERFLOW_INDENT}+${tasks.length - budget} ${overflowSuffix}`);
 }
 return lines;
}
