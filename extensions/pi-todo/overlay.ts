/**
 * Persistent overlay widget above the editor (P0-B / B4 / P3-E §28).
 *
 * Layer chain:
 *   graph → projection → read-model → format → overlay
 *
 * The overlay consumes:
 *   - projectActiveView (B1) — single source for grouping + counts.
 *   - buildDependencyPresentation (B3) — for blocked-row deps.
 *   - formatTaskRow (B2) — for row rendering.
 *
 * Visibility rules (LOCKED B4):
 *   - active > 0              → header + sections + ✓ summary
 *   - active = 0, completed > 0 → just "✓ N completed · /todos completed"
 *   - active = 0, completed = 0 → overlay hidden ([])
 *   - archived is NEVER shown (no count, no section). Use `/todos archived`.
 *
 * Per-section budgets (NEVER global slice):
 *   RUNNING ≤ 2, READY ≤ 3, BLOCKED ≤ 2.
 *   Each section's overflow is its own "+N <role>" line; no section
 *   can be crowded out by another's growth.
 *
 * P3-E §28 — overlay presentation identity = ScopeKey, NOT sessionId.
 * The overlay reads from OverlaySnapshotCache (ScopeKey-keyed
 * presentation cache populated ONLY from successful durable load /
 * commit). It does NOT import from store.ts; legacy
 * session-local state is no longer a production read source.
 */

import { formatTaskRow, formatTaskRowStyled, truncateToWidth, visibleWidth } from "./format.ts";
import { projectActiveView } from "./projection.ts";
import { buildDependencyPresentation } from "./read-model.ts";
import type { ScopeKey } from "./persistence-contract.ts";
import type {
  ActiveView,
  Task,
  TaskDependencyPresentation,
  TaskState,
} from "./types.ts";
import type { OverlaySnapshotCache } from "./overlay-snapshot-cache.ts";

const WIDGET_KEY = "pi-todo";

/** Per-section budgets (LOCKED B4). */
const RUNNING_BUDGET = 2;
const READY_BUDGET = 3;
const BLOCKED_BUDGET = 2;

/** Empty TaskState returned by the cache when no scope has been
 *  loaded / committed yet. Used as the cold-cache sentinel so the
 *  overlay renders [] without ever touching legacy store. */
const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/** Minimal theme contract the overlay needs (v0.6). The runtime hands
 *  the real theme to the setWidget factory; tests pass a fake. Only
 *  well-known pi theme tokens are requested, so every built-in theme
 *  satisfies it. */
export interface OverlayTheme {
  fg(color: string, text: string): string;
}

type UICtx = {
  setWidget(
    key: string,
    value:
      | undefined
      | string[]
      | ((
          tui: { requestRender(force?: boolean): void },
          theme: OverlayTheme,
        ) => {
          render: (width: number) => string[];
          invalidate: () => void;
          dispose: () => void;
        }),
    options?: { placement?: string },
  ): void;
};

// ── Pure rendering function (exported for unit testing) ─────────────────

/**
 * Render the overlay content for `state` at the given terminal width.
 *
 * Returns string[] which the TUI renders line-by-line. Empty array
 * means "no overlay" (caller should call setWidget(undefined)).
 *
 * The header `Todos · ▶N ◆M ○K · ✓C` omits sections whose count is 0,
 * so it adapts to whatever is present.
 *
 * v0.6: an optional `theme` colorizes the presentation (accent header,
 * dim section labels, role-colored row prefixes, dim deps suffixes).
 * WITHOUT a theme the output is byte-identical to the plain rendering —
 * the un-themed path stays the canonical test oracle.
 */
export function renderOverlay(
  state: TaskState,
  width: number,
  theme?: OverlayTheme,
): string[] {
  const view = projectActiveView(state);
  const hasActive = view.counts.active > 0;
  const hasCompleted = view.counts.completedVisible > 0;

  // Hidden: nothing to show.
  if (!hasActive && !hasCompleted) return [];

  // Pre-compute deps map for blocked rows.
  const depsMap = new Map<number, readonly TaskDependencyPresentation[]>();
  for (const task of view.blocked) {
    depsMap.set(task.id, buildDependencyPresentation(state, task.id));
  }

  const lines: string[] = [];

  // Header.
  const header = formatHeader(view, theme);
  if (header) {
    lines.push(header);
    lines.push("");
  }

  // Sections (each gated by its own count > 0; no global slice).
  const running = renderSection(
    "RUNNING",
    view.running,
    RUNNING_BUDGET,
    "running",
    width,
    depsMap,
    theme,
  );
  if (running.length > 0) {
    lines.push(...running);
    lines.push("");
  }

  const ready = renderSection(
    "READY",
    view.ready,
    READY_BUDGET,
    "ready",
    width,
    depsMap,
    theme,
  );
  if (ready.length > 0) {
    lines.push(...ready);
    lines.push("");
  }

  const blocked = renderSection(
    "BLOCKED",
    view.blocked,
    BLOCKED_BUDGET,
    "blocked",
    width,
    depsMap,
    theme,
  );
  if (blocked.length > 0) {
    lines.push(...blocked);
    lines.push("");
  }

  // ✓ summary (only when there are visible completed tasks).
  if (hasCompleted) {
    const count = `✓ ${view.counts.completedVisible} completed`;
    const hint = " · /todos completed";
    lines.push(
      theme
        ? theme.fg("success", count) + theme.fg("dim", hint)
        : `${count}${hint}`,
    );
  }

  // Strip trailing blank line(s).
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/** Format the "Todos · ▶N ◆M ○K · ✓C" header; empty if no active tasks.
 *  ✓N is appended with a " · " separator from the active counts. When
 *  there are no active tasks, this returns "" — the caller emits a
 *  standalone ✓ summary line in that case instead. */
function formatHeader(view: ActiveView, theme?: OverlayTheme): string {
  const sep = theme ? theme.fg("dim", " · ") : " · ";
  const active: string[] = [];
  if (view.running.length > 0)
    active.push(
      theme
        ? theme.fg("accent", `▶${view.running.length}`)
        : `▶${view.running.length}`,
    );
  if (view.ready.length > 0)
    active.push(
      theme
        ? theme.fg("text", `◆${view.ready.length}`)
        : `◆${view.ready.length}`,
    );
  if (view.blocked.length > 0)
    active.push(
      theme
        ? theme.fg("muted", `○${view.blocked.length}`)
        : `○${view.blocked.length}`,
    );
  if (active.length === 0) return "";
  let result = theme
    ? theme.fg("accent", "Todos") + sep + active.join(" ")
    : `Todos · ${active.join(" ")}`;
  if (view.counts.completedVisible > 0) {
    result +=
      sep +
      (theme
        ? theme.fg("success", `✓${view.counts.completedVisible}`)
        : `✓${view.counts.completedVisible}`);
  }
  return result;
}

/** Render a single section with its per-budget overflow. */
function renderSection(
  label: string,
  tasks: readonly Task[],
  budget: number,
  role: "running" | "ready" | "blocked",
  width: number,
  depsMap: ReadonlyMap<number, readonly TaskDependencyPresentation[]>,
  theme?: OverlayTheme,
): string[] {
  if (tasks.length === 0) return [];
  const lines: string[] = [];
  lines.push(theme ? theme.fg("dim", label) : label);
  const shown = tasks.slice(0, budget);
  for (const t of shown) {
    const ctx = {
      role,
      width,
      dependencies: depsMap.get(t.id),
    };
    lines.push(
      theme ? formatTaskRowStyled(t, ctx, theme) : formatTaskRow(t, ctx),
    );
  }
  if (tasks.length > budget) {
    const overflow = `+${tasks.length - budget} ${role}`;
    lines.push(theme ? theme.fg("muted", overflow) : overflow);
  }
  return lines;
}

const COMPACT_LABEL = "任务";

function padCompactCell(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Frame the compact status as the same kind of open-sided horizontal table
 * used elsewhere in Pi's terminal UI. Pi supplies the surrounding widget
 * spacing, so the component itself does not add another blank row.
 */
function frameCompactOverlay(
  content: readonly string[],
  width: number,
  theme?: OverlayTheme,
): string[] {
  const labelWidth = visibleWidth(COMPACT_LABEL);
  const dividerColumn = labelWidth + 2;
  const contentWidth = width - dividerColumn - 2;
  if (contentWidth < 2) {
    return content.map((line) => truncateToWidth(line, width));
  }

  const border = (junction: "┬" | "┴"): string => {
    const line = "─".repeat(dividerColumn) + junction + "─".repeat(width - dividerColumn - 1);
    return theme ? theme.fg("dim", line) : line;
  };
  const vertical = theme ? theme.fg("dim", "│") : "│";
  const lines = [border("┬")];
  for (const [index, value] of content.entries()) {
    const label = index === 0 ? COMPACT_LABEL : "";
    const labelCell = ` ${label}${" ".repeat(labelWidth - visibleWidth(label) + 1)}`;
    lines.push(
      (theme ? theme.fg("muted", labelCell) : labelCell) +
      vertical +
      ` ${padCompactCell(value, contentWidth)}`,
    );
  }
  lines.push(border("┴"));
  return lines;
}

/** Default editor strip: a one-row table; narrow terminals may use two content rows. */
export function renderCompactOverlay(state: TaskState, width: number, theme?: OverlayTheme): string[] {
  const view = projectActiveView(state);
  if (!view.counts.active || width < 1) return [];
  const task = view.running[0] ?? view.ready[0] ?? view.blocked[0];
  if (!task) return [];
  const role = view.running.length ? "running" : view.ready.length ? "ready" : "blocked";
  const progress = `${view.counts.completedVisible}/${view.counts.active + view.counts.completedVisible} 已完成 · /todos`;
  const contentWidth = Math.max(1, width - visibleWidth(COMPACT_LABEL) - 4);
  const row = formatTaskRow(task, { role, width: contentWidth });
  const combined = `${row} · ${progress}`;
  let content: string[];
  if (visibleWidth(combined) <= contentWidth) {
    content = theme
      ? [
          formatTaskRowStyled(task, { role, width: contentWidth }, theme) +
          theme.fg("dim", ` · ${progress}`),
        ]
      : [combined];
  } else {
    content = theme
      ? [
          formatTaskRowStyled(task, { role, width: contentWidth }, theme),
          theme.fg("dim", truncateToWidth(progress, contentWidth)),
        ]
      : [row, truncateToWidth(progress, contentWidth)];
  }
  return frameCompactOverlay(content, width, theme);
}

// ── Widget class (registration lifecycle only) ────────────────────────────

export class TodoOverlay {
  private uiCtx: UICtx | undefined;
  private registered = false;
  private tui: { requestRender(force?: boolean): void } | undefined;
  private theme: OverlayTheme | undefined;
  private mode: "compact" | "full" | "hidden" = "compact";
  private suspended = false;

  constructor(
    private readonly cache: OverlaySnapshotCache,
    private readonly scopeGetter: () => ScopeKey | undefined,
  ) {}

  setMode(mode: "compact" | "full" | "hidden"): void {
    this.mode = mode;
    this.update();
  }

  /** Temporarily hide the editor strip while a task window is open. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    this.update();
  }

  private render(width: number): string[] {
    if (this.suspended || this.mode === "hidden") return [];
    return this.mode === "full" ? renderOverlay(this.currentState(), width, this.theme)
      : renderCompactOverlay(this.currentState(), width, this.theme);
  }

  setUICtx(ctx: UICtx): void {
    // Identity compare: repeat session_start on the same ctx is a no-op;
    // a NEW ctx (/reload) invalidates so update() re-registers.
    if (ctx !== (this.uiCtx as unknown)) {
      this.uiCtx = ctx;
      this.registered = false;
      this.tui = undefined;
      this.theme = undefined;
    }
  }

  /**
   * Read the current scope's cached TaskState. Returns EMPTY_STATE
   * when no scope is active OR the active scope has not been loaded /
   * committed yet (cold cache). NEVER touches legacy store.
   */
  private currentState(): TaskState {
    const scope = this.scopeGetter();
    if (scope === undefined) return EMPTY_STATE;
    return this.cache.getOrEmpty(scope);
  }

  update(): void {
    if (!this.uiCtx) return;
    const lines = this.render(80);
    if (lines.length === 0) {
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
        (tui, theme) => {
          this.tui = tui;
          this.theme = theme;
          return {
            render: (width: number) =>
              this.render(width),
            invalidate: () => {},
            dispose: () => {
              this.tui = undefined;
              this.theme = undefined;
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

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}
