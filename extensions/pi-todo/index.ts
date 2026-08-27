/**
 * pi-todo — a todo tool for the model with a live overlay.
 *
 * State is derived, not stored: every successful tool result carries a
 * full snapshot in `details`, and lifecycle events (session_start /
 * compact / tree) rebuild state by replaying the branch. That is what
 * makes the list survive /reload and compaction — sessions are
 * append-only and compaction summaries never drop branch entries.
 *
 * Zero runtime dependencies: every pi import is type-only; the tool
 * parameter schema is a hand-written JSON Schema literal (TypeBox
 * schemas ARE JSON Schema, so pi's validation accepts it as-is).
 *
 * File map:
 *   - types.ts    domain types + JSON Schema (no runtime pi imports)
 *   - reducer.ts  pure (state, action, params) → { state, op }
 *   - store.ts    per-session slots + foreground pointer + branch replay
 *   - format.ts   LLM/command/overlay formatting + terminal sanitizer
 *   - overlay.ts  setWidget overlay above the editor
 *   - index.ts    this file: tool + /todos registration, event wiring
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatContent } from "./format.ts";
import { formatTodosCommand } from "./format.ts";
import { applyTaskMutation } from "./reducer.ts";
import {
  clearForegroundSession,
  commitState,
  evictSession,
  getExpanded,
  getForegroundSession,
  getState,
  replayFromBranch,
  replaceState,
  setExpanded,
  setForegroundSession,
  sid,
} from "./store.ts";
import { TodoOverlay } from "./overlay.ts";
import {
  TODO_PARAMS_SCHEMA,
  type TaskMutationParams,
  type TodoDetails,
} from "./types.ts";

const TOOL_NAME = "todo";
const COMMAND_NAME = "todos";

const DEFAULT_PROMPT_SNIPPET =
  "Plan and track multi-step work via `todo`. When the user asks you to " +
  "plan, break work into tasks, or make a todo list, CREATE todo items " +
  "with the tool — never list the plan as plain text. Mark each task " +
  "in_progress BEFORE starting it and completed the moment its success " +
  "criterion holds — do not batch, do not defer, do not leave tasks open " +
  "'just in case'.";

const DEFAULT_PROMPT_GUIDELINES: string[] = [
  "When to CREATE: (1) the user asks you to plan, break down work, or make tasks / a todo list (e.g. 制定任务, 列个计划, 拆解一下, create a plan, break this down) — ALWAYS create todo items via the tool; presenting the plan as plain text instead is a failure mode; (2) the work has 3+ steps; (3) the user hands you a list of tasks; (4) new multi-step instructions arrive. Skip it only for single trivial tasks.",
  "Mark a task in_progress BEFORE starting it. Keep exactly one task in_progress at a time. After EVERY successful tool call, BEFORE starting any new action, ask yourself: 'Did this tool call just close the task I had in_progress?' If yes, update its status to completed FIRST, then proceed to the next action. Never batch completions at end-of-turn.",
  "Mark a task completed EXACTLY ONCE all three hold: (a) every tool call tagged to it returned without isError; (b) any test that exercises this task passes (or no test exists); (c) no unresolved error remains in the current tool result stream. If you cannot tick all three, KEEP the task in_progress and state which one is blocking in the activeForm. Do NOT use the vague 'implementation might be partial' rationale — it is unverifiable and the default fallback that causes tasks to stay open indefinitely.",
  "Status is pending → in_progress → completed, plus deleted tombstones (immutable; ids are never reused, even after clear).",
  'To change status: {"action":"update","id":3,"status":"completed"}. An update with no mutable field is rejected.',
  "blockedBy expresses dependencies (A blocked by B). Create: pass blockedBy. Update: addBlockedBy / removeBlockedBy (additive). Cycles and self-blocks are rejected.",
  "list hides deleted tombstones by default; includeDeleted:true shows them. status filters the list.",
];

// pi-core throws this exact phrase from an invalidated ctx proxy after
// session replacement/reload; lifecycle replay swallows ONLY this.
function isStaleCtxError(e: unknown): boolean {
  return /stale after session replacement/.test(String(e));
}

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// pi's tool renderer contract (0.84.x): renderCall/renderResult must
// return a Component — an object with render(width): string[] — never a
// raw string. The TUI pushes the return value into the render container
// via addChild() without validation; a string detonates the next render
// frame inside Box.render ("child.render is not a function").
function lineComponent(line: string) {
  return { render: (_width: number) => [line] };
}

export default function (pi: ExtensionAPI): void {
  let overlay: TodoOverlay | undefined;
  let uiCtx:
    | {
        setWidget(
          key: string,
          value: unknown,
          options?: { placement?: string },
        ): void;
      }
    | undefined;

  function refreshOverlay(): void {
    if (!uiCtx || !overlay) return;
    overlay.update();
  }

  // ── tool ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: TOOL_NAME,
    label: "Todo",
    description:
      "Plan and track multi-step work as a task list. Actions: create, update (status/fields/dependencies), list, get, delete (tombstone), clear. When asked to plan or break down work, create todo items instead of writing them in text.",
    promptSnippet: DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
    parameters: TODO_PARAMS_SCHEMA,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = sid(ctx);
      const result = applyTaskMutation(
        getState(sessionId),
        params.action,
        params as TaskMutationParams,
      );
      commitState(sessionId, result.state);
      const text = formatContent(result.op, result.state);
      // The snapshot IS the persistence layer — replay reads the last
      // valid details from the branch. Error results carry the unchanged
      // pre-mutation state, so replaying them is harmless.
      const details: TodoDetails = {
        tasks: result.state.tasks,
        nextId: result.state.nextId,
      };
      return { content: [{ type: "text", text }], details };
    },

    renderCall(args, theme) {
      const a = args as {
        action?: string;
        subject?: string;
        id?: number;
        status?: string;
      };
      const what = a.subject
        ? ` ${a.subject}`
        : a.id === undefined
          ? ""
          : ` #${a.id}`;
      const extra = a.status ? ` → ${a.status}` : "";
      return lineComponent(
        theme.fg("dim", `todo ${a.action ?? "?"}${what}${extra}`),
      );
    },

    renderResult(result, _opts, theme) {
      const text = result?.content?.[0]?.text ?? "";
      const first = String(text).split("\n")[0];
      return lineComponent(theme.fg("dim", first));
    },
  });

  // ── /todos command ─────────────────────────────────────────────────────

  pi.registerCommand(COMMAND_NAME, {
    description:
      "List todos, or toggle overlay expansion. Usage: /todos [expand|collapse|status]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }
      const state = getState(sid(ctx));
      const sessionId = sid(ctx);
      const sub = String(args ?? "")
        .trim()
        .toLowerCase();
      const visibleCount = state.tasks.filter(
        (t) => t.status !== "deleted",
      ).length;

      switch (sub) {
        case "expand": {
          setExpanded(sessionId, true);
          ctx.ui.notify(
            `Overlay expanded — showing all ${visibleCount} tasks`,
            "info",
          );
          return;
        }
        case "collapse": {
          setExpanded(sessionId, false);
          ctx.ui.notify(`Overlay collapsed — capped at 12 rows`, "info");
          return;
        }
        case "status": {
          const expanded = getExpanded(sessionId);
          ctx.ui.notify(
            expanded
              ? `Overlay: expanded (showing all ${visibleCount} tasks)`
              : `Overlay: collapsed (showing up to 12 of ${visibleCount})`,
            "info",
          );
          return;
        }
        case "": {
          if (visibleCount === 0) {
            ctx.ui.notify("No todos yet. Ask the agent to add some!", "info");
            return;
          }
          ctx.ui.notify(formatTodosCommand(state), "info");
          return;
        }
        default: {
          ctx.ui.notify(
            `Unknown subcommand: ${sub}. Usage: /todos [expand|collapse|status]`,
            "error",
          );
        }
      }
    },
  });

  // ── lifecycle ──────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    let id: string;
    try {
      id = sid(ctx);
      replaceState(id, replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
      return;
    }
    if (!ctx.hasUI) return;
    // LATEST-WINS foreground: switching to session B re-binds the overlay
    // even while A stays alive (pi fires no shutdown on switches).
    setForegroundSession(id);
    uiCtx = ctx.ui;
    overlay ??= new TodoOverlay();
    overlay.setUICtx(ctx.ui as typeof uiCtx & object);
    try {
      refreshOverlay();
    } catch (e) {
      console.warn(`[pi-todo] overlay refresh failed: ${formatError(e)}`);
    }
  });

  // Re-key + replay on compact/tree; refresh only when the replayed
  // session IS the foreground one.
  pi.on("session_compact", async (_event, ctx) => {
    try {
      const id = sid(ctx);
      replaceState(id, replayFromBranch(ctx));
      if (id === getForegroundSession()) refreshOverlay();
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    try {
      const id = sid(ctx);
      replaceState(id, replayFromBranch(ctx));
      if (id === getForegroundSession()) refreshOverlay();
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    let id = "";
    try {
      id = sid(ctx);
    } catch {
      // stale ctx on disposal race — treated as foreground below
    }
    evictSession(id);
    if (id === "" || id === getForegroundSession()) {
      clearForegroundSession(id);
      try {
        overlay?.dispose();
      } finally {
        overlay = undefined;
        uiCtx = undefined;
      }
    }
  });

  // The tool's execute already committed state; just repaint. Refresh
  // regardless of foreground — a child's tool result still updates its
  // own slot, and getRenderState() reads the foreground slot either way.
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return;
    refreshOverlay();
  });
}
