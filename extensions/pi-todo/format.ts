/**
 * View formatting: LLM-facing envelope text, /todos output, overlay rows,
 * and the terminal sanitizer. All model-controlled text passes through
 * sanitizeTerminalText before reaching the renderer.
 */

import type { Op } from "./reducer.ts";
import type {
   ActiveView,
   MutationError,
   Task,
   TaskDependencyPresentation,
   TaskDetailContext,
   TaskRowContext,
   TaskRowRole,
   TaskState,
   TaskStatus,
   TodosSnapshotContext,
} from "./types.ts";

/**
 * Strip terminal control sequences from model-controlled task text:
 * complete CSI/OSC escapes (both ESC-[ and C1 introducers) are dropped
 * whole, newlines/tabs collapse to spaces so fields cannot reshape the
 * layout, and bidi controls are removed so a field cannot reorder how
 * neighbouring output reads.
 */
export function sanitizeTerminalText(value: string): string {
   let result = "";
   for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);

      // CSI: consume through its final byte. An incomplete sequence owns
      // the remainder, which must not become visible terminal text.
      if (code === 0x9b || (code === 0x1b && value.charCodeAt(i + 1) === 0x5b)) {
         i += code === 0x1b ? 2 : 1;
         while (i < value.length && !isEscapeFinal(value.charCodeAt(i))) i += 1;
         continue;
      }

      // OSC, DCS, SOS, PM and APC control strings. They end at BEL (OSC)
      // or ST; an unterminated string is discarded through end-of-input.
      const next = value.charCodeAt(i + 1);
      const stringKind = code === 0x1b && [0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(next)
         ? next
         : [0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(code)
           ? code
           : undefined;
      if (stringKind !== undefined) {
         const osc = stringKind === 0x5d || stringKind === 0x9d;
         i += code === 0x1b ? 2 : 1;
         while (i < value.length) {
            const current = value.charCodeAt(i);
            if ((osc && current === 0x07) || current === 0x9c) break;
            if (current === 0x1b && value.charCodeAt(i + 1) === 0x5c) {
               i += 1;
               break;
            }
            i += 1;
         }
         continue;
      }

      // Other ESC sequences may contain intermediate bytes before a final
      // byte (for example charset selection). Consume the complete unit.
      if (code === 0x1b) {
         i += 1;
         while (i < value.length && value.charCodeAt(i) >= 0x20 && value.charCodeAt(i) <= 0x2f) i += 1;
         continue;
      }

      if (code === 0x2028 || code === 0x2029 || code === 0x0a || code === 0x0d || code === 0x09) {
         result += " ";
      } else if (
         (code >= 0x00 && code <= 0x1f) ||
         (code >= 0x7f && code <= 0x9f) ||
         code === 0x200e ||
         code === 0x200f ||
         (code >= 0x202a && code <= 0x202e) ||
         (code >= 0x2066 && code <= 0x2069)
      ) {
         continue;
      } else {
         result += value[i];
      }
   }
   return result;
}

function isEscapeFinal(code: number): boolean {
   return code >= 0x40 && code <= 0x7e;
}

/** `[status] #id subject (activeForm) ⛓ #deps` — the list content line. */
function formatListLine(t: Task): string {
   const deps = t.blockedBy?.length
      ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
      : "";
   const form =
      t.status === "in_progress" && t.activeForm
         ? ` (${sanitizeTerminalText(t.activeForm)})`
         : "";
   return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${deps}`;
}

function formatGetLines(task: Task, state: TaskState): string {
   const blocks = state.tasks
      .filter((t) => t.status !== "deleted" && t.blockedBy?.includes(task.id))
      .map((t) => `#${t.id}`);
   const lines = [
      `#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`,
   ];
   if (task.description)
      lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
   if (task.activeForm)
      lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
   if (task.blockedBy?.length) {
      lines.push(
         `  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`,
      );
   }
   if (blocks.length > 0) lines.push(`  blocks: ${blocks.join(", ")}`);
   if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
   return lines.join("\n");
}

/** The op → LLM-facing text. Closed switch; new Op variants fail to compile. */
export function formatContent(op: Op, state: TaskState): string {
   switch (op.kind) {
      case "create": {
         const t = state.tasks.find((x) => x.id === op.taskId);
         return t
            ? `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending)`
            : `Created #${op.taskId}`;
      }
      case "update": {
         if (!op.changed) {
            return `No change: #${op.id} already matches the requested values`;
         }
         const transition =
            op.fromStatus === op.toStatus
               ? ""
               : ` (${op.fromStatus} → ${op.toStatus})`;
         return `Updated #${op.id}${transition}`;
      }
      case "delete":
         return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
      case "clear":
         return `Cleared ${op.count} tasks`;
      case "start": {
         const t = state.tasks.find((x) => x.id === op.id);
         return `▶ #${op.id}${t ? " " + sanitizeTerminalText(t.subject) : ""}`;
      }
      case "finish": {
         const t = state.tasks.find((x) => x.id === op.id);
         return `✓ #${op.id}${t ? " " + sanitizeTerminalText(t.subject) : ""}`;
      }
      case "reopen": {
         const t = state.tasks.find((x) => x.id === op.id);
         const subj = t ? " " + sanitizeTerminalText(t.subject) : "";
         return `○ #${op.id}${subj} reopened`;
      }
      case "list": {
         let view = state.tasks;
         if (!op.includeDeleted)
            view = view.filter((t) => t.status !== "deleted");
         if (op.statusFilter)
            view = view.filter((t) => t.status === op.statusFilter);
         return view.length === 0
            ? "No tasks"
            : view.map(formatListLine).join("\n");
      }
      case "get":
         return formatGetLines(op.task, state);
      case "archive": {
         if (op.count === 0) return "Archived 0 tasks";
         const subjects = op.ids
            .map((id) => {
               const t = state.tasks.find((x) => x.id === id);
               return t
                  ? `#${id} ${sanitizeTerminalText(t.subject)}`
                  : `#${id}`;
            })
            .join("\n");
         return `Archived ${op.count} tasks:\n${subjects}`;
      }
      case "restore": {
         if (op.count === 0) return "Restored 0 tasks";
         const subjects = op.ids
            .map((id) => {
               const t = state.tasks.find((x) => x.id === id);
               return t
                  ? `#${id} ${sanitizeTerminalText(t.subject)}`
                  : `#${id}`;
            })
            .join("\n");
         return `Restored ${op.count} tasks:\n${subjects}`;
      }
      case "error":
         return formatMutationError(op.error);
      default: {
         // Exhaustiveness guard: a new Op variant without a case fails here.
         const _exhaustive: never = op;
         return `Error: unknown op ${String(_exhaustive)}`;
      }
   }
}

// ── /todos command output ────────────────────────────────────────────────

/** Format a structured MutationError for LLM / CLI consumption. The
 *  `code` discriminator drives the prefix; context fields render the
 *  specifics. Returning `Error:` prefix keeps grep-on-stderr simple for
 *  callers and matches the pre-A2.2 message shape. */
export function formatMutationError(error: MutationError): string {
   switch (error.code) {
      case "SUBJECT_REQUIRED":
         return "Error: subject required for create";
      case "ID_REQUIRED":
         return "Error: id required for this action";
      case "TASK_NOT_FOUND":
         return `Error: #${error.id} not found`;
      case "DEPENDENCY_NOT_FOUND":
         return `Error: dependency #${error.depId} not found`;
      case "DEPENDENCY_DELETED":
         return `Error: dependency #${error.depId} is deleted (cannot be a dependency)`;
      case "DEPENDENCY_SELF":
         return `Error: #${error.depId} cannot block on itself`;
      case "DEPENDENCY_CYCLE":
         return `Error: would create a dependency cycle via [${error.attempted.join(", ")}]`;
      case "INVALID_TRANSITION":
         return `Error: illegal transition ${error.from} → ${error.to}`;
      case "TOMBSTONE_IMMUTABLE":
         return `Error: #${error.id} is deleted (tombstones are immutable)`;
      case "ALREADY_DELETED":
         return `Error: #${error.id} is already deleted`;
      case "ALREADY_ARCHIVED":
         return `Error: #${error.id} is already archived`;
      case "NOT_ARCHIVED":
         return `Error: #${error.id} is not archived (use /todos archive first)`;
      case "ARCHIVE_REQUIRES_COMPLETED":
         return `Error: #${error.id} cannot be archived (status must be completed)`;
      case "TASK_REFERENCED":
         return `Error: #${error.id} is referenced by ${error.referencedBy.map((r) => `#${r}`).join(", ")} (archive or remove the dependency first)`;
      case "MUTABLE_FIELDS_REQUIRED":
         return "Error: update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, removeBlockedBy";
      case "UNKNOWN_ACTION":
         return `Error: unknown action (${error.action})`;
      default: {
         const _exhaustive: never = error;
         void _exhaustive;
         return "Error: unhandled mutation error";
      }
   }
}

export function countsOf(state: TaskState): {
   total: number;
   pending: number;
   inProgress: number;
   completed: number;
} {
   const visible = state.tasks.filter((t) => t.status !== "deleted");
   const by = (s: TaskStatus) => visible.filter((t) => t.status === s).length;
   return {
      total: visible.length,
      pending: by("pending"),
      inProgress: by("in_progress"),
      completed: by("completed"),
   };
}

/** Multi-line /todos body, grouped by status. */
export function formatTodosCommand(state: TaskState): string {
   const visible = state.tasks.filter((t) => t.status !== "deleted");
   const groups: Record<"pending" | "in_progress" | "completed", Task[]> = {
      pending: [],
      in_progress: [],
      completed: [],
   };
   for (const t of visible) {
      if (t.status !== "deleted") groups[t.status].push(t);
   }
   const c = countsOf(state);
   const lines: string[] = [];
   const header: string[] = [];
   if (c.completed > 0) header.push(`${c.completed}/${c.total} completed`);
   if (c.inProgress > 0) header.push(`${c.inProgress} in progress`);
   if (c.pending > 0) header.push(`${c.pending} pending`);
   lines.push(header.length > 0 ? header.join(" · ") : "Todos");
   const icon: Record<string, string> = {
      pending: "○",
      in_progress: "◐",
      completed: "✓",
   };
   for (const key of ["in_progress", "pending", "completed"] as const) {
      if (groups[key].length === 0) continue;
      lines.push(`── ${key.replace("_", " ")} ──`);
      for (const t of groups[key]) {
         const form =
            t.activeForm && t.status === "in_progress"
               ? ` (${sanitizeTerminalText(t.activeForm)})`
               : "";
         const deps = t.blockedBy?.length
            ? ` ⛓${t.blockedBy.map((id) => `#${id}`).join(",")}`
            : "";
         lines.push(
            `${icon[key]} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${deps}`,
         );
      }
   }
   return lines.join("\n");
}

// ── overlay rows ─────────────────────────────────────────────────────────

/** One overlay row (without the ├─ gutter): icon subject (form) deps. */
export function formatOverlayRow(
   task: Task,
   theme: { fg(color: string, text: string): string },
   showIds: boolean,
): string {
   const ICON: Record<string, string> = {
      in_progress: "◐",
      completed: "✓",
      pending: "○",
   };
   // pi's TUI theme rejects unknown color keys with an uncaught exception
   // that crashes the whole renderer. Pending rows get the neutral
   // "muted" tone; the fallback covers future status variants.
   const COLOR: Record<string, string> = {
      in_progress: "accent",
      completed: "dim",
      pending: "muted",
   };
   const icon = ICON[task.status] ?? "○";
   const color = COLOR[task.status] ?? "muted";
   const id = showIds ? `#${task.id} ` : "";
   const form =
      task.status === "in_progress" && task.activeForm
         ? theme.fg("dim", ` (${sanitizeTerminalText(task.activeForm)})`)
         : "";
   const deps = task.blockedBy?.length
      ? theme.fg("dim", ` ⛓${task.blockedBy.map((d) => `#${d}`).join(",")}`)
      : "";
   return (
      theme.fg(color, `${icon} ${id}${sanitizeTerminalText(task.subject)}`) +
      form +
      deps
   );
}

// ── grapheme-aware width + truncation (no pi-tui runtime dep) ────────────

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function charWidth(segment: string): number {
   if (/^\p{Mark}+$/u.test(segment)) return 0;
   if (
      /\p{Extended_Pictographic}/u.test(segment) ||
      /\p{Regional_Indicator}/u.test(segment) ||
      segment.includes("\ufe0f") ||
      segment.includes("\u20e3")
   )
      return 2;
   const code = segment.codePointAt(0) ?? 0;
   if (
      (code >= 0x1f000 && code <= 0x1ffff) ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x2300 && code <= 0x23ff)
   )
      return 2;
   return (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60)
      ? 2
      : 1;
}

export function visibleWidth(text: string): number {
   const clean = text.replace(ANSI, "").replace(/\t/g, "   ");
   let width = 0;
   for (const { segment } of segmenter.segment(clean))
      width += charWidth(segment);
   return width;
}

export function truncateToWidth(
   text: string,
   maxWidth: number,
   ellipsis = "…",
): string {
   if (maxWidth <= 0) return "";
   if (visibleWidth(text) <= maxWidth) return text;
   const suffix = visibleWidth(ellipsis) <= maxWidth ? ellipsis : "";
   const target = maxWidth - visibleWidth(suffix);
   let result = "";
   let used = 0;
   let cursor = 0;
   const single = new RegExp(ANSI.source, "g");
   let sawAnsi = false;
   let m: RegExpExecArray | null;
   while ((m = single.exec(text)) !== null) {
      for (const { segment } of segmenter.segment(
         text.slice(cursor, m.index),
      )) {
         const w = charWidth(segment);
         if (used + w > target)
            return result + suffix + (sawAnsi ? "\x1b[0m" : "");
         result += segment;
         used += w;
      }
      result += m[0];
      sawAnsi = true;
      cursor = m.index + m[0].length;
   }
   for (const { segment } of segmenter.segment(text.slice(cursor))) {
      const w = charWidth(segment);
      if (used + w > target) break;
      result += segment;
      used += w;
   }
   return result + suffix + (sawAnsi ? "\x1b[0m" : "");
}

// ── B2 presentation primitives ─────────────────────────────────────────────────
//
// Single-source row renderer + multi-line detail panel + grouped snapshot.
// Layer invariants (LOCKED):
//   1. Formatter does NOT classify — caller passes TaskRowRole.
//   2. Formatter does NOT read graph — caller pre-computes
//      TaskDependencyPresentation via graph.unsatisfiedDependencies
//      and graph.brokenDependencies.
//   3. Formatter does NOT scan state.tasks — all required data is in
//      the task + context arguments.
//   4. visibleWidth / truncateToWidth accept ANSI-free input. They
//      strip ANSI defensively (existing helper). Architecture:
//        sanitize → plain-text layout/width/truncate → optional ANSI.
//      Future styling adds color AFTER layout, never affects width.
//   5. Subject priority > dependency suffix. Never truncate subject
//      to keep "+N" — drop deps (tier 3) before truncating (tier 4).

/** Alias for visibleWidth kept for B2 contract naming. The existing
 *  visibleWidth implementation already handles CJK / emoji / combining
 *  marks / ANSI via Intl.Segmenter + Unicode range tables. */
export const displayWidth = visibleWidth;

// ── Visual language (LOCKED B2) ──────────────────────────────────────────────

const ROLE_ICON: Record<TaskRowRole, string> = {
   running: "▶",
   ready: "◆",
   blocked: "○",
   completed: "✓",
   archived: "·", // mid-dot (not ✓) — archive is visibility, not lifecycle;
   // using ✓ would falsely imply "done" when the task may still be pending.
};

// ── Dependency presentation helpers ──────────────────────────────────────────

/** Render a single dep ref with a marker for non-waiting kinds.
 *  waiting   → #18
 *  missing   → #99?
 *  deleted   → #17† */
function formatOneDep(d: TaskDependencyPresentation): string {
   const marker = d.kind === "missing" ? "?" : d.kind === "deleted" ? "†" : "";
   return `#${d.id}${marker}`;
}

/** Build the "← #18 #19 +1" suffix. Returns "" if no deps.
 *  full    → all refs (e.g. "← #18 #19 #20 #21")
 *  compact → first 2 + count (e.g. "← #18 #19 +2")
 *  For deps.length <= 2, full and compact are identical. */
function formatDepsSuffix(
   deps: readonly TaskDependencyPresentation[] | undefined,
   level: "full" | "compact",
): string {
   if (!deps || deps.length === 0) return "";
   if (level === "compact" && deps.length > 2) {
      const first = formatOneDep(deps[0] as TaskDependencyPresentation);
      const second = formatOneDep(deps[1] as TaskDependencyPresentation);
      return `← ${first} ${second} +${deps.length - 2}`;
   }
   return `← ${deps.map(formatOneDep).join(" ")}`;
}

// ── formatTaskRow (single-source row renderer) ──────────────────────────────────

/**
 * Render a single task row. 4-tier deterministic width degradation:
 *   Tier 1: full subject + full deps (when fit)
 *   Tier 2: full subject + compact deps (when full doesn't fit)
 *   Tier 3: full subject, no deps suffix (when neither deps form fits)
 *   Tier 4: subject truncated (LAST resort)
 *
 * Subject NEVER truncated to keep "+N". Width is total terminal columns.
 * Empty subject → just the prefix (no duplicate #id).
 */
/** Structured row parts (v0.6): the SAME tier-degraded pieces
 *  formatTaskRow joins, exposed separately so themed surfaces (the
 *  overlay widget) can color the prefix / subject / deps segments
 *  independently without string surgery on rendered output.
 *  Invariant: formatTaskRow(task, ctx) === joinRowParts(planTaskRowParts(task, ctx)).
 *  Returns null when width <= 0 (mirrors formatTaskRow's "" short-circuit). */
export interface TaskRowParts {
   prefix: string;
   subject: string;
   depsSuffix: string;
}

/** Join parts exactly the way formatTaskRow always did: single spaces,
 *  absent pieces skipped. */
export function joinRowParts(parts: TaskRowParts): string {
   return [parts.prefix, parts.subject, parts.depsSuffix]
      .filter((s) => s !== "")
      .join(" ");
}

export function planTaskRowParts(
   task: Task,
   ctx: TaskRowContext,
): TaskRowParts | null {
   const { role, width, dependencies } = ctx;
   if (width <= 0) return null;

   const icon = ROLE_ICON[role];
   const prefix = `${icon} #${task.id}`;
   const prefixWidth = displayWidth(prefix);
   if (prefixWidth >= width) {
      // Prefix itself doesn't fit — truncate it (rare; only in extreme widths).
      return {
         prefix: truncateToWidth(prefix, width, "…"),
         subject: "",
         depsSuffix: "",
      };
   }

   const subjectSpace = width - prefixWidth - 1;
   const subject = sanitizeTerminalText(task.subject);
   const fullDepsStr = formatDepsSuffix(dependencies, "full");
   const compactDepsStr = formatDepsSuffix(dependencies, "compact");
   const hasDeps = fullDepsStr.length > 0;

   // Empty subject → just prefix (no duplicate id).
   if (subject === "") {
      return { prefix, subject: "", depsSuffix: "" };
   }

   // Tier 1: full subject + full deps.
   if (hasDeps) {
      if (
         displayWidth(subject) + 1 + displayWidth(fullDepsStr) <=
         subjectSpace
      ) {
         return { prefix, subject, depsSuffix: fullDepsStr };
      }
      // Tier 2: full subject + compact deps (only when compact differs).
      if (compactDepsStr !== fullDepsStr) {
         if (
            displayWidth(subject) + 1 + displayWidth(compactDepsStr) <=
            subjectSpace
         ) {
            return { prefix, subject, depsSuffix: compactDepsStr };
         }
      }
   }

   // Tier 3: full subject, no deps suffix.
   if (displayWidth(subject) <= subjectSpace) {
      return { prefix, subject, depsSuffix: "" };
   }

   // Tier 4: truncate subject (last resort).
   return {
      prefix,
      subject: truncateToWidth(subject, subjectSpace, "…"),
      depsSuffix: "",
   };
}

export function formatTaskRow(task: Task, ctx: TaskRowContext): string {
   const parts = planTaskRowParts(task, ctx);
   return parts === null ? "" : joinRowParts(parts);
}

/** Themed row for TUI widget surfaces (v0.6): same tier degradation as
 *  formatTaskRow via planTaskRowParts, with per-segment coloring:
 *    prefix (icon + #id)  → role color (running=accent, ready=default,
 *                            blocked=muted, completed=dim, archived=dim)
 *    subject              → default foreground (untinted)
 *    deps suffix          → dim
 *  Theme contract mirrors formatOverlayRow: only well-known theme tokens
 *  are used, so any pi theme satisfies it without crashing the renderer. */
export function formatTaskRowStyled(
   task: Task,
   ctx: TaskRowContext,
   theme: { fg(color: string, text: string): string },
): string {
   const parts = planTaskRowParts(task, ctx);
   if (parts === null) return "";
   const ROLE_COLOR: Record<TaskRowRole, string> = {
      running: "accent",
      ready: "text",
      blocked: "muted",
      completed: "dim",
      archived: "dim",
   };
   let out = theme.fg(ROLE_COLOR[ctx.role], parts.prefix);
   if (parts.subject !== "") out += " " + parts.subject;
   if (parts.depsSuffix !== "") out += " " + theme.fg("dim", parts.depsSuffix);
   return out;
}

// ── formatTaskDetail (multi-line panel) ──────────────────────────────────────

/** Format a multi-line detail panel for a single task.
 *  Layout (lines, joined by "\n"):
 *    <icon> #<id>  <subject>
 *
 *    State        <role>           (only if ctx.role)
 *    Status       <status>
 *    Created      <YYYY-MM-DD HH:MM>   (only if createdAt > 0)
 *    Updated      <...>                 (only if updatedAt > 0)
 *    Archived     <...>                 (only if archivedAt)
 *
 *    Depends on   <deps | —>
 *    Required by  <ids | —>
 *
 *    Description
 *      <text>
 *
 *    Metadata
 *      key: value
 */
export function formatTaskDetail(task: Task, ctx: TaskDetailContext): string[] {
   const lines: string[] = [];

   // Header: "#<id>  <subject>" — no icon (icon only on single-row views).
   lines.push(`#${task.id}  ${sanitizeTerminalText(task.subject)}`);

   lines.push("");

   // Aligned two-column layout: label padded to LABEL_WIDTH + space + value.
   const LABEL_WIDTH = 12;
   const detailLine = (label: string, value: string): string =>
      label.padEnd(LABEL_WIDTH) + " " + value;

   if (ctx.role) lines.push(detailLine("State", ctx.role));
   lines.push(detailLine("Status", task.status));
   if (task.createdAt > 0) {
      lines.push(detailLine("Created", formatTimestamp(task.createdAt)));
   }
   if (task.updatedAt > 0) {
      lines.push(detailLine("Updated", formatTimestamp(task.updatedAt)));
   }
   if (task.archivedAt !== undefined) {
      lines.push(detailLine("Archived", formatTimestamp(task.archivedAt)));
   }

   lines.push("");

   const depsInline =
      ctx.dependencies && ctx.dependencies.length > 0
         ? ctx.dependencies.map(formatOneDep).join(" ")
         : "—";
   lines.push(detailLine("Depends on", depsInline));

   const reqInline =
      ctx.reverseDependencyIds && ctx.reverseDependencyIds.length > 0
         ? ctx.reverseDependencyIds.map((id) => `#${id}`).join(" ")
         : "—";
   lines.push(detailLine("Required by", reqInline));

   if (task.description && task.description.trim().length > 0) {
      lines.push("");
      lines.push("Description");
      const descLines = formatMultilineText(
         sanitizeTerminalText(task.description),
         ctx.width - 2,
      );
      for (const dl of descLines) lines.push(`  ${dl}`);
   }

   if (task.metadata && Object.keys(task.metadata).length > 0) {
      lines.push("");
      lines.push("Metadata");
      for (const key of Object.keys(task.metadata).sort()) {
         const value = task.metadata[key];
         lines.push(
            `  ${sanitizeTerminalText(key)}: ${stringifyMetadataValue(value)}`,
         );
      }
   }

   return lines;
}

// ── formatTodosSnapshot (default /todos output) ──────────────────────────────────

/** Render the grouped active view + completed count summary that
 *  /todos emits. /todos completed / /todos archived / /todos all are
 *  SEPARATE B3 compositions, NOT in this function. */
export function formatTodosSnapshot(
   view: ActiveView,
   ctx: TodosSnapshotContext,
): string[] {
   const lines: string[] = [];

   if (view.running.length > 0) {
      lines.push("RUNNING");
      for (const task of view.running) {
         lines.push(
            formatTaskRow(task, {
               role: "running",
               width: ctx.width,
               dependencies: ctx.dependencies?.get(task.id),
            }),
         );
      }
      lines.push("");
   }

   if (view.ready.length > 0) {
      lines.push("READY");
      for (const task of view.ready) {
         lines.push(
            formatTaskRow(task, {
               role: "ready",
               width: ctx.width,
            }),
         );
      }
      lines.push("");
   }

   if (view.blocked.length > 0) {
      lines.push("BLOCKED");
      for (const task of view.blocked) {
         lines.push(
            formatTaskRow(task, {
               role: "blocked",
               width: ctx.width,
               dependencies: ctx.dependencies?.get(task.id),
            }),
         );
      }
      lines.push("");
   }

   if (view.counts.completedVisible > 0) {
      lines.push(
         `✓ ${view.counts.completedVisible} completed · /todos completed`,
      );
   }

   return lines;
}

// ── formatTasksList (B3 thin helper) ─────────────────────────────────────────

/** Render a list of tasks as rows sharing the same role + width.
 *  Used by /todos ready|blocked|completed|archived and by /todos all
 *  section composition. B3 reads projection.ts to get task lists and
 *  builds a deps map via read-model.buildDependencyPresentation, then
 *  hands it here. */
export function formatTasksList(
   tasks: readonly Task[],
   role: TaskRowRole,
   width: number,
   dependencies?: ReadonlyMap<number, readonly TaskDependencyPresentation[]>,
): string[] {
   return tasks.map((task) =>
      formatTaskRow(task, {
         role,
         width,
         dependencies: dependencies?.get(task.id),
      }),
   );
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Format epoch milliseconds as YYYY-MM-DD HH:MM (local time).
 *  Zero (legacy unset) → "—". */
function formatTimestamp(ms: number): string {
   if (ms <= 0) return "—";
   const d = new Date(ms);
   const pad = (n: number) => String(n).padStart(2, "0");
   return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Wrap text to lines respecting display width, breaking on whitespace
 *  where possible. Newlines in input are preserved as hard breaks. */
function formatMultilineText(text: string, maxWidth: number): string[] {
   if (maxWidth <= 0) return [];
   const out: string[] = [];
   for (const paragraph of text.split(/\r?\n/)) {
      if (paragraph === "") {
         out.push("");
         continue;
      }
      let current = "";
      let used = 0;
      for (const word of paragraph.split(/\s+/)) {
         if (word === "") continue;
         const wordWidth = displayWidth(word);
         if (used === 0) {
            current = word;
            used = wordWidth;
         } else if (used + 1 + wordWidth <= maxWidth) {
            current += " " + word;
            used += 1 + wordWidth;
         } else {
            out.push(current);
            current = word;
            used = wordWidth;
         }
      }
      if (current) out.push(current);
   }
   return out;
}

/** Deterministic stringify for metadata values:
 *   primitive → String(value)
 *   string   → sanitized, single-line (newlines collapsed to spaces)
 *   object   → compact JSON
 *   otherwise → "[unserializable]" */
function stringifyMetadataValue(value: unknown): string {
   if (value === null) return "null";
   if (value === undefined) return "undefined";
   if (typeof value === "string") {
      // Normalize line endings BEFORE sanitize: sanitizeTerminalText
      // already replaces \r, \n, \t each with space individually, so
      // "\r\n" would become "  " (double space). Collapse \r\n → \n first.
      const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      return sanitizeTerminalText(normalized).replace(/\n/g, " ");
   }
   if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
   }
   if (typeof value === "object") {
      try {
         const s = JSON.stringify(value);
         return s ?? "[unserializable]";
      } catch {
         return "[unserializable]";
      }
   }
   return "[unserializable]";
}
