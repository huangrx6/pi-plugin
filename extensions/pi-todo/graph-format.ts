/**
 * graph-format.ts — P2-B (graph query formatter).
 *
 * Pure presentation: P2-A query result + width → string[].
 * This is the ONLY path that turns query results into CLI text.
 *
 * Module invariants (P2-B LOCK):
 *   1. P2-B accepts P2-A query results + width. NEVER accepts TaskState.
 *   2. Forbidden imports: graph / projection / read-model / reducer /
 *      store / index + all mutation-*.ts.
 *   3. Allowed imports: format.ts (canonical row primitives) +
 *      type-only graph-query.ts + type-only types.ts (when needed).
 *   4. P2-B never calls queryNextTasks / queryWhyTask /
 *      queryUnlocksTask. P2-A is the only path that builds results.
 *   5. P2-B NEVER reads semantic status or archival state from
 *      formatter input. A synthetic Task.status value may exist
 *      solely to satisfy the frozen formatTaskRow Task-shaped API.
 *      That synthetic value carries NO presentation semantics.
 *   6. Indented task rows receive `width - visibleWidth(INDENT)`.
 *      Headers on their own lines NEVER reduce row width.
 *   7. Task role glyphs (◆ ▶ ○ ✓ ·) come from frozen formatTaskRow.
 *      P2-B does not independently map ready / running / blocked /
 *      completed / archived roles to glyphs.
 *   8. Blocker markers (? / †) are presentation-only facts derived
 *      from TaskDependencyPresentation.kind; blocker rendering
 *      performs no state lookup.
 *   9. Input ordering preserved. No .filter / .sort / vertical budget.
 *  10. result.kind determines section structure and static wording.
 *      task.role determines canonical task-row presentation.
 *      P2-B never reconstructs one from the other.
 *  11. UX wording locked (see WHY_SUFFIX / static constants).
 *  12. P0 / P1 / P2-A remain FROZEN.
 */

import { formatTaskRow, visibleWidth } from "./format.ts";
import type {
 NextTasksResult,
 TaskPresentation,
 UnlocksTaskResult,
 WhyTaskResult,
} from "./graph-query.ts";
import type { Task, TaskDependencyPresentation } from "./types.ts";

// ── Static UX wording (LOCK §11) ──────────────────────────────────────────

const NEXT_HEADER = "Next:";
const NEXT_EMPTY = "No tasks are ready.";

const BLOCKED_HEADER = "Blocked by:";

const UNLOCKS_HEADER = "Completing this task would make ready:";
const UNLOCKS_EMPTY =
 "Completing this task would not directly unlock any tasks.";

const INDENT = "  ";

const WHY_SUFFIX: Record<
 "ready" | "running" | "completed" | "archived",
 string
> = {
 ready: "Ready to start.",
 running: "Already running.",
 completed: "Completed.",
 archived: "Archived.",
};

const UNLOCKS_COMPLETED_SUFFIX = "Already completed.";

function notFoundLine(id: number): string {
 return `Task #${id} not found.`;
}

// ── Public API: formatNextTasks ────────────────────────────────────────

export function formatNextTasks(
 result: NextTasksResult,
 width: number,
): string[] {
 if (result.tasks.length === 0) return [NEXT_EMPTY];
 // LOCK §6: indented rows get `width - INDENT`. Header on its own line
 // does not consume row width.
 const rowWidth = Math.max(1, width - visibleWidth(INDENT));
 return [
  NEXT_HEADER,
  ...result.tasks.map((t) => INDENT + formatPresentationRow(t, rowWidth)),
 ];
}

// ── Public API: formatWhyTask ──────────────────────────────────────────

export function formatWhyTask(result: WhyTaskResult, width: number): string[] {
 switch (result.kind) {
  case "not-found":
   return [notFoundLine(result.id)];

  case "ready":
  case "running":
  case "completed":
  case "archived":
   return [formatPresentationRow(result.task, width), WHY_SUFFIX[result.kind]];

  case "blocked": {
   const head = formatPresentationRow(result.task, width);
   const rowWidth = Math.max(1, width - visibleWidth(INDENT));
   return [
    head,
    "",
    BLOCKED_HEADER,
    ...result.blocking.map(
     (d) => INDENT + formatBlockingDependency(d, rowWidth),
    ),
   ];
  }
 }
}

// ── Public API: formatUnlocksTask ──────────────────────────────────────

export function formatUnlocksTask(
 result: UnlocksTaskResult,
 width: number,
): string[] {
 switch (result.kind) {
  case "not-found":
   return [notFoundLine(result.id)];

  case "completed":
   return [formatPresentationRow(result.task, width), UNLOCKS_COMPLETED_SUFFIX];

  case "archived":
   return [formatPresentationRow(result.task, width), "Archived."];

  case "unlocks": {
   const head = formatPresentationRow(result.task, width);
   if (result.unlocks.length === 0) {
    return [head, "", UNLOCKS_EMPTY];
   }
   const rowWidth = Math.max(1, width - visibleWidth(INDENT));
   return [
    head,
    "",
    UNLOCKS_HEADER,
    ...result.unlocks.map((t) => INDENT + formatPresentationRow(t, rowWidth)),
   ];
  }
 }
}

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Render a TaskPresentation through the canonical frozen formatter.
 *
 * The synthetic `Task` only needs `id` + `subject`; formatTaskRow does
 * not read status / archivedAt. The `status: "pending"` literal is
 * type-shape filler required by the frozen Task-shaped API; it carries
 * no presentation semantics (LOCK §5).
 */
function formatPresentationRow(p: TaskPresentation, width: number): string {
 const task: Task = {
  id: p.id,
  subject: p.subject,
  status: "pending",
  createdAt: 0,
  updatedAt: 0,
 };
 return formatTaskRow(task, {
  role: p.role,
  width: Math.max(1, width),
 });
}

/**
 * Render a single blocker presentation as `○ #N` / `○ #N?` / `○ #N†`.
 *
 * The `○` glyph and prefix construction are reused from frozen
 * formatTaskRow by passing an empty subject (LOCK §7: formatTaskRow
 * returns just the prefix when subject is empty). The marker (? / †)
 * is presentation-only and derived from TaskDependencyPresentation.kind
 * (LOCK §8); no state lookup.
 */
function formatBlockingDependency(
 d: TaskDependencyPresentation,
 width: number,
): string {
 const base = formatPresentationRow(
  {
   id: d.id,
   subject: "",
   role: "blocked",
  },
  width,
 );
 const marker = d.kind === "missing" ? "?" : d.kind === "deleted" ? "†" : "";
 return base + marker;
}
