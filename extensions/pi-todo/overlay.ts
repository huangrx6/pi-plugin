/**
 * Persistent overlay widget above the editor.
 *
 * setWidget contract: register once via factory form, refresh with
 * requestRender(). Auto-hides when no visible tasks remain. Content-row
 * budget is a constant — NO config file, NO per-render disk IO (the
 * per-render readFileSync anti-pattern observed in other todo overlays
 * is exactly what this avoids).
 *
 * Overflow rule: drop completed rows first (they are history), then
 * truncate the non-completed tail, and summarize with "+N more (x
 * completed, y pending)". Per-row #id prefixes appear only when some
 * task carries a dependency — otherwise ids have no anchor.
 *
 * Expand / collapse: `/todos expand` shows every visible task with no row
 * cap (use when 12-row truncation hides work you need to see); `/todos
 * collapse` returns to the 12-row budget. The expanded flag is a per-
 * session UI preference kept in the foreground slot — it is NOT replayed
 * from the branch, so legacy sessions start collapsed and a /reload
 * resets the choice (intentional: the user re-toggles explicitly).
 */

import { countsOf, formatOverlayRow, truncateToWidth } from "./format.ts";
import { getExpanded, getForegroundSession, getRenderState } from "./store.ts";
import type { Task } from "./types.ts";

const WIDGET_KEY = "pi-todo";

/** Fixed content-row budget (heading excluded). Constant by design. */
export const MAX_ROWS = 12;

type Theme = { fg(color: string, text: string): string };
type UICtx = {
  setWidget(
    key: string,
    value:
      | undefined
      | string[]
      | ((
          tui: { requestRender(force?: boolean): void },
          theme: Theme,
        ) => {
          render: (width: number) => string[];
          invalidate: () => void;
          dispose: () => void;
        }),
    options?: { placement?: string },
  ): void;
};

export class TodoOverlay {
  private uiCtx: UICtx | undefined;
  private registered = false;
  private tui: { requestRender(force?: boolean): void } | undefined;

  setUICtx(ctx: UICtx): void {
    // Identity compare: repeat session_start on the same ctx is a no-op;
    // a NEW ctx (/reload) invalidates so update() re-registers.
    if (ctx !== (this.uiCtx as unknown)) {
      this.uiCtx = ctx;
      this.registered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const visible = visibleTasks();
    if (visible.length === 0) {
      if (this.registered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.registered = false;
        this.tui = undefined;
      }
      return;
    }
    if (this.registered) {
      this.tui?.requestRender();
    } else {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, factoryTheme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(factoryTheme, width),
            invalidate: () => {},
            dispose: () => {
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.registered = true;
    }
  }

  isRegistered(): boolean {
    return this.registered;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const state = getRenderState();
    const visible = visibleTasks();
    if (visible.length === 0) return [];

    const c = countsOf(state);
    const showIds = visible.some((t) => (t.blockedBy?.length ?? 0) > 0);
    const hasActive = c.pending + c.inProgress > 0;
    const expanded = getExpanded(getForegroundSession());

    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const heading = truncateToWidth(
      theme.fg(
        headingColor,
        `${headingIcon} Todos (${c.completed}/${c.total})`,
      ),
      width,
    );
    const lines = [heading];

    const { shown, hiddenCompleted, truncatedTail } = computeShownTasks(
      visible,
      expanded,
      MAX_ROWS,
    );

    for (const task of shown) {
      const isLastShown = shown.indexOf(task) === shown.length - 1;
      const nothingHidden = hiddenCompleted + truncatedTail === 0;
      const gutter = isLastShown && nothingHidden ? "└─" : "├─";
      lines.push(
        truncateToWidth(
          `${theme.fg("dim", gutter)} ${formatOverlayRow(task, theme, showIds)}`,
          width,
        ),
      );
    }

    const summary = formatOverflowSummary(
      hiddenCompleted,
      truncatedTail,
      expanded,
      theme,
    );
    if (summary !== null) {
      lines.push(truncateToWidth(summary, width));
    }

    // Trailing spacer so the panel isn't glued to the editor box.
    lines.push("");
    return lines;
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}

function visibleTasks(): Task[] {
  return getRenderState().tasks.filter((t) => t.status !== "deleted");
}

// ── Pure helpers (exported so unit tests can exercise them) ─────────────

/**
 * Decide which tasks to render and how many are hidden.
 *
 * Collapsed (expanded === false): keep a fixed `maxRows` budget. Drop
 * completed rows first, then truncate the non-completed tail. One row
 * is reserved for the overflow summary when anything is hidden.
 *
 * Expanded (expanded === true): render every visible task, no cap. The
 * trade-off is explicit — the user opted in via `/todos expand`.
 */
export function computeShownTasks(
  visible: Task[],
  expanded: boolean,
  maxRows: number,
): { shown: Task[]; hiddenCompleted: number; truncatedTail: number } {
  if (expanded) {
    return { shown: visible, hiddenCompleted: 0, truncatedTail: 0 };
  }
  const inner = maxRows - 1; // reserve overflow summary slot when needed
  if (visible.length <= inner) {
    return { shown: visible, hiddenCompleted: 0, truncatedTail: 0 };
  }
  const nonCompleted = visible.filter((t) => t.status !== "completed");
  const completed = visible.filter((t) => t.status === "completed");
  const room = inner - 1; // one row for the summary itself
  if (nonCompleted.length <= room) {
    const shown = [
      ...nonCompleted,
      ...completed.slice(0, room - nonCompleted.length),
    ];
    const hiddenCompleted =
      completed.length - (shown.length - nonCompleted.length);
    return { shown, hiddenCompleted, truncatedTail: 0 };
  }
  const shown = nonCompleted.slice(0, room);
  const truncatedTail = nonCompleted.length - room;
  const hiddenCompleted = completed.length;
  return { shown, hiddenCompleted, truncatedTail };
}

/**
 * Build the overflow summary gutter line. Returns null when nothing is
 * hidden AND we're collapsed (no summary needed) — the caller is then
 * free to swap the last task's gutter from ├─ to └─.
 *
 * Always returns a string when expanded, so the user sees the collapse
 * hint even when nothing is hidden.
 */
export function formatOverflowSummary(
  hiddenCompleted: number,
  truncatedTail: number,
  expanded: boolean,
  theme: { fg(color: string, text: string): string },
): string | null {
  const gutter = theme.fg("dim", "└─");
  if (expanded) {
    return `${gutter} ${theme.fg("dim", "/todos collapse")}`;
  }
  const totalHidden = hiddenCompleted + truncatedTail;
  if (totalHidden === 0) return null;
  const parts: string[] = [];
  if (hiddenCompleted > 0) parts.push(`${hiddenCompleted} completed`);
  if (truncatedTail > 0) parts.push(`${truncatedTail} pending`);
  const summary = theme.fg(
    "dim",
    `+${totalHidden} more (${parts.join(", ")})`,
  );
  const hint = theme.fg("dim", "/todos expand");
  return `${gutter} ${summary} · ${hint}`;
}
