/**
 * View formatting: LLM-facing envelope text, /todos output, overlay rows,
 * and the terminal sanitizer. All model-controlled text passes through
 * sanitizeTerminalText before reaching the renderer.
 */

import type { Op } from "./reducer.ts";
import type { Task, TaskState, TaskStatus } from "./types.ts";

/**
 * Strip terminal control sequences from model-controlled task text:
 * complete CSI/OSC escapes (both ESC-[ and C1 introducers) are dropped
 * whole, newlines/tabs collapse to spaces so fields cannot reshape the
 * layout, and bidi controls are removed so a field cannot reorder how
 * neighbouring output reads.
 */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) =>
      c === "\n" || c === "\r" || c === "\t" ? " " : "",
    )
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** `[status] #id subject (activeForm) ⛓ #deps` — the list content line. */
function formatListLine(t: Task): string {
  const deps = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  const form =
    t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
  return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${deps}`;
}

function formatGetLines(task: Task, state: TaskState): string {
  const blocks = state.tasks
    .filter((t) => t.status !== "deleted" && t.blockedBy?.includes(task.id))
    .map((t) => `#${t.id}`);
  const lines = [`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`];
  if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
  if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
  if (task.blockedBy?.length) {
    lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
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
      const transition = op.fromStatus === op.toStatus ? "" : ` (${op.fromStatus} → ${op.toStatus})`;
      return `Updated #${op.id}${transition}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
    case "clear":
      return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter) view = view.filter((t) => t.status === op.statusFilter);
      return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return `Error: ${op.message}`;
    default: {
      // Exhaustiveness guard: a new Op variant without a case fails here.
      const _exhaustive: never = op;
      return `Error: unknown op ${String(_exhaustive)}`;
    }
  }
}

// ── /todos command output ────────────────────────────────────────────────

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
      const form = t.activeForm && t.status === "in_progress" ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
      const deps = t.blockedBy?.length ? ` ⛓${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
      lines.push(`${icon[key]} #${t.id} ${sanitizeTerminalText(t.subject)}${form}${deps}`);
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
  const ICON: Record<string, string> = { in_progress: "◐", completed: "✓", pending: "○" };
  const COLOR: Record<string, string> = {
    in_progress: "accent",
    completed: "dim",
    pending: "default",
  };
  const icon = ICON[task.status] ?? "○";
  const color = COLOR[task.status] ?? "default";
  const id = showIds ? `#${task.id} ` : "";
  const form =
    task.status === "in_progress" && task.activeForm
      ? theme.fg("dim", ` (${sanitizeTerminalText(task.activeForm)})`)
      : "";
  const deps = task.blockedBy?.length
    ? theme.fg("dim", ` ⛓${task.blockedBy.map((d) => `#${d}`).join(",")}`)
    : "";
  return theme.fg(color, `${icon} ${id}${sanitizeTerminalText(task.subject)}`) + form + deps;
}

// ── grapheme-aware width + truncation (no pi-tui runtime dep) ────────────

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function charWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
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
  for (const { segment } of segmenter.segment(clean)) width += charWidth(segment);
  return width;
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const suffix = visibleWidth(ellipsis) <= maxWidth ? ellipsis : "";
  const target = maxWidth - visibleWidth(suffix);
  let result = "";
  let used = 0;
  let cursor = 0;
  const single = new RegExp(ANSI.source);
  let m: RegExpExecArray | null;
  while ((m = single.exec(text)) !== null) {
    for (const { segment } of segmenter.segment(text.slice(cursor, m.index))) {
      const w = charWidth(segment);
      if (used + w > target) return result + suffix + "\x1b[0m";
      result += segment;
      used += w;
    }
    result += m[0];
    cursor = m.index + m[0].length;
  }
  for (const { segment } of segmenter.segment(text.slice(cursor))) {
    const w = charWidth(segment);
    if (used + w > target) break;
    result += segment;
    used += w;
  }
  return result + suffix + "\x1b[0m";
}

