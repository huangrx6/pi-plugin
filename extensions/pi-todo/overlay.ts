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

import { formatTaskRow } from "./format.ts";
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

type UICtx = {
  setWidget(
    key: string,
    value:
      | undefined
      | string[]
      | ((tui: { requestRender(force?: boolean): void }) => {
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
 */
export function renderOverlay(state: TaskState, width: number): string[] {
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
  const header = formatHeader(view);
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
  );
  if (blocked.length > 0) {
    lines.push(...blocked);
    lines.push("");
  }

  // ✓ summary (only when there are visible completed tasks).
  if (hasCompleted) {
    lines.push(
      `✓ ${view.counts.completedVisible} completed · /todos completed`,
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
function formatHeader(view: ActiveView): string {
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

/** Render a single section with its per-budget overflow. */
function renderSection(
  label: string,
  tasks: readonly Task[],
  budget: number,
  role: "running" | "ready" | "blocked",
  width: number,
  depsMap: ReadonlyMap<number, readonly TaskDependencyPresentation[]>,
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
    lines.push(`+${tasks.length - budget} ${role}`);
  }
  return lines;
}

// ── Widget class (registration lifecycle only) ────────────────────────────

export class TodoOverlay {
  private uiCtx: UICtx | undefined;
  private registered = false;
  private tui: { requestRender(force?: boolean): void } | undefined;

  constructor(
    private readonly cache: OverlaySnapshotCache,
    private readonly scopeGetter: () => ScopeKey | undefined,
  ) {}

  setUICtx(ctx: UICtx): void {
    // Identity compare: repeat session_start on the same ctx is a no-op;
    // a NEW ctx (/reload) invalidates so update() re-registers.
    if (ctx !== (this.uiCtx as unknown)) {
      this.uiCtx = ctx;
      this.registered = false;
      this.tui = undefined;
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
    const state = this.currentState();
    const lines = renderOverlay(state, 80);
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
        (tui) => {
          this.tui = tui;
          return {
            render: (width: number) =>
              renderOverlay(this.currentState(), width),
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

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
  }
}
