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
 */

import { countsOf, formatOverlayRow, truncateToWidth } from "./format.ts";
import { getRenderState } from "./store.ts";
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

    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const heading = truncateToWidth(
      theme.fg(headingColor, `${headingIcon} Todos (${c.completed}/${c.total})`),
      width,
    );
    const lines = [heading];

    // Budget: keep non-completed rows, drop completed first, then tail.
    const inner = MAX_ROWS - 1; // reserve overflow summary slot when needed
    const nonCompleted = visible.filter((t) => t.status !== "completed");
    const completed = visible.filter((t) => t.status === "completed");
    let shown: Task[];
    let hiddenCompleted = 0;
    let truncatedTail = 0;
    if (visible.length <= inner) {
      shown = visible;
    } else {
      const room = inner - 1; // one row for the summary
      if (nonCompleted.length <= room) {
        shown = [...nonCompleted, ...completed.slice(0, room - nonCompleted.length)];
        hiddenCompleted = completed.length - (shown.length - nonCompleted.length);
      } else {
        shown = nonCompleted.slice(0, room);
        truncatedTail = nonCompleted.length - room;
        hiddenCompleted = completed.length;
      }
    }

    for (const task of shown) {
      lines.push(
        truncateToWidth(
          `${theme.fg("dim", shown.indexOf(task) === shown.length - 1 && hiddenCompleted + truncatedTail === 0 ? "└─" : "├─")} ${formatOverlayRow(task, theme, showIds)}`,
          width,
        ),
      );
    }

    const totalHidden = hiddenCompleted + truncatedTail;
    if (totalHidden > 0) {
      const parts: string[] = [];
      if (hiddenCompleted > 0) parts.push(`${hiddenCompleted} completed`);
      if (truncatedTail > 0) parts.push(`${truncatedTail} pending`);
      lines.push(
        truncateToWidth(
          `${theme.fg("dim", "└─")} ${theme.fg("dim", `+${totalHidden} more (${parts.join(", ")})`)}`,
          width,
        ),
      );
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
