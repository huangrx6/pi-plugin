/**
 * index.ts — P3-E (production integration).
 *
 * Wires the frozen P0/P1/P2/P3-A/B/C/D semantic authorities into the Pi
 * runtime. Production state authority is exclusively
 * CurrentPersistedTodoEnvelope loaded through P3-B. Legacy
 * session-local Map<sessionId, TaskState> is no longer read by any
 * production path (P3-E LOCK §2).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parseMutationCommand, isLifecycle } from "./mutation-command.ts";
import {
 parseAndNormalizeSelector,
 resolveSelectorIds,
 validateMutationCommand,
} from "./mutation-selector.ts";
import { applyTaskMutation } from "./reducer.ts";
import { buildMutationPlan, applyMutationPlan } from "./mutation-executor.ts";
import { buildMutationOutcome } from "./mutation-outcome.ts";
import { formatContent, formatTaskRow, formatTasksList, sanitizeTerminalText, truncateToWidth } from "./format.ts";
import { formatBoundedOverview } from "./overview-format.ts";
import { parseGraphCommand } from "./graph-command.ts";
import { formatCurrentTask } from "./current-task-format.ts";
import { formatTaskDetailRich } from "./task-detail-format.ts";
import { formatSelectorPolicyNotice } from "./selector-policy-notice.ts";
import {
 parseWorkflowCommand,
 type WorkflowCommand,
} from "./workflow-command.ts";
import { formatWorkflowSyntaxError } from "./workflow-format.ts";
import {
 formatNextTasks,
 formatUnlocksTask,
 formatWhyTask,
} from "./graph-format.ts";
import {
 queryNextTasks,
 queryUnlocksTask,
 queryWhyTask,
} from "./graph-query.ts";
import {
 projectActiveView,
 projectArchived,
 projectClosed,
 projectCompleted,
} from "./projection.ts";
import { buildDependencyPresentation } from "./read-model.ts";
import { TodoOverlay } from "./overlay.ts";
import type {
 CurrentPersistedTodoEnvelope,
 ReplayMutationMaterial,
 ScopeKey,
} from "./persistence-contract.ts";
import type { GraphCommand } from "./graph-command.ts";
import { ScopeResolutionError } from "./workspace-scope.ts";
import type { TaskMutationParams, TaskState, TodoDetails } from "./types.ts";
import { TODO_PARAMS_SCHEMA } from "./types.ts";

import { createObservedReduceContext } from "./replay-capture.ts";
import { OverlaySnapshotCache } from "./overlay-snapshot-cache.ts";
import {
 createProductionTodoPersistence,
 type TodoRuntimePersistence,
} from "./runtime-persistence.ts";
import {
 formatInfrastructureNotice,
 scopeResolutionToNotice,
} from "./persistence-format.ts";
import {
 formatMutationError,
 formatMutationOutcome,
} from "./mutation-format.ts";
import { parseTodosCommand } from "./parse-todos-command.ts";
import {
 TaskBrowserComponent,
 type TaskBrowserIntent,
 type TaskBrowserKeybindings,
 type TaskBrowserSession,
 type TaskBrowserTheme,
 type TaskBrowserTui,
 type TaskBrowserView,
} from "./task-browser.ts";

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
 "Mark a task in_progress when beginning that unit of work; mark it completed when its acceptance criteria are met. Update at meaningful task transitions, not after every tool call. Keep the list aligned with actual progress.",
 "Complete a task when its intended result and relevant validation are satisfied. Recovered intermediate errors do not prevent completion. If work is still blocked, describe the concrete remaining issue in activeForm.",
 "Status is pending → in_progress → completed, with close available for unfinished work and deleted tombstones (immutable; ids are never reused, even after clear).",
 'To change status: {"action":"update","id":3,"status":"completed"}. An update with no mutable field is rejected.',
 "blockedBy expresses dependencies (A blocked by B). Create: pass blockedBy. Update: addBlockedBy / removeBlockedBy (additive). Cycles and self-blocks are rejected.",
 "list hides deleted tombstones by default; includeDeleted:true shows them. status filters the list.",
];

// ── factory options ───────────────────────────────────────────────────

export interface FactoryOptions {
 readonly persistence?: TodoRuntimePersistence;
}

// ── P2 graph grammar ──────────────────────────────────────────────────

const MUTATION_VERBS: ReadonlySet<string> = new Set([
 "start",
 "finish",
 "reopen",
 "close",
 "archive",
 "restore",
]);

const GRAPH_VERB_USAGE: Readonly<Record<string, string>> = {
 next: "Usage: /todos next",
 why: "Usage: /todos why <id>",
 unlocks: "Usage: /todos unlocks <id>",
};

function graphSyntaxUsage(verb: string): string {
 return GRAPH_VERB_USAGE[verb] ?? "Usage: /todos {next|why <id>|unlocks <id>}";
}

// ── render helpers (pure: take state, return lines) ─────────────────

const DEFAULT_WIDTH = 80;

type DepMap = Map<number, ReturnType<typeof buildDependencyPresentation>>;

function renderDefault(state: TaskState, width: number): string[] {
 const view = projectActiveView(state);
 const total = view.running.length + view.ready.length + view.blocked.length;
 const closed = projectClosed(state);
 // Empty / archived-only state: user-visible "No todos." (per B4
 // invariant, archived never contributes to completedVisible).
 if (total === 0 && view.counts.completedVisible === 0 && closed.length === 0) {
  return ["No todos."];
 }
 if (total === 0 && view.counts.completedVisible === 0 && closed.length > 0) {
  return [`No active todos. ${closed.length} task(s) ended; open /todos all to review.`];
 }
 const depsMap = buildBlockedDepsMap(state, view.blocked);
 // P4-C1: default /todos is a bounded overview with per-section
 // budgets and explicit "+N more <role>" drill-down hints. Section
 // drill-downs (/todos ready / blocked / completed / archived)
 // remain full-list via renderReady / renderBlocked / etc.
 return formatBoundedOverview(view, {
  width,
  dependencies: depsMap,
 });
}

function renderReady(state: TaskState, width: number): string[] {
 const view = projectActiveView(state);
 if (view.ready.length === 0) return ["No ready todos."];
 return formatTasksList(view.ready, "ready", width);
}

function renderBlocked(state: TaskState, width: number): string[] {
 const view = projectActiveView(state);
 if (view.blocked.length === 0) return ["No blocked todos."];
 const depsMap = buildBlockedDepsMap(state, view.blocked);
 return formatTasksList(view.blocked, "blocked", width, depsMap);
}

function renderCompleted(state: TaskState, width: number): string[] {
 const tasks = projectCompleted(state);
 if (tasks.length === 0) return ["No completed todos."];
 return formatTasksList(tasks, "completed", width);
}

function renderArchived(state: TaskState, width: number): string[] {
 const tasks = projectArchived(state);
 if (tasks.length === 0) return ["No archived todos."];
 return formatTasksList(tasks, "archived", width);
}

function renderAll(state: TaskState, width: number): string[] {
 const view = projectActiveView(state);
 const completed = projectCompleted(state);
 const closed = projectClosed(state);
 const archived = projectArchived(state);
 const hasActive =
  view.running.length + view.ready.length + view.blocked.length > 0;
 if (!hasActive && completed.length === 0 && closed.length === 0 && archived.length === 0) {
  return ["No todos."];
 }
 const lines: string[] = [];
 const depsMap = buildBlockedDepsMap(state, view.blocked);
 if (hasActive) {
  lines.push("ACTIVE");
  lines.push("");
  if (view.running.length > 0) {
   lines.push("RUNNING");
   for (const t of view.running) {
    lines.push(formatTaskRow(t, { role: "running", width }));
   }
   lines.push("");
  }
  if (view.ready.length > 0) {
   lines.push("READY");
   for (const t of view.ready) {
    lines.push(formatTaskRow(t, { role: "ready", width }));
   }
   lines.push("");
  }
  if (view.blocked.length > 0) {
   lines.push("BLOCKED");
   for (const t of view.blocked) {
    lines.push(
     formatTaskRow(t, {
      role: "blocked",
      width,
      dependencies: depsMap.get(t.id),
     }),
    );
   }
   lines.push("");
  }
 }
 if (completed.length > 0) {
  lines.push("COMPLETED");
  for (const t of completed) {
   lines.push(formatTaskRow(t, { role: "completed", width }));
  }
  lines.push("");
 }
 if (closed.length > 0) {
  lines.push("CLOSED");
  for (const t of closed) lines.push(formatTaskRow(t, { role: "closed", width }));
  lines.push("");
 }
 if (archived.length > 0) {
  lines.push("ARCHIVED");
  for (const t of archived) {
   lines.push(formatTaskRow(t, { role: "archived", width }));
  }
  lines.push("");
 }
 while (lines.length > 0 && lines[lines.length - 1] === "") {
  lines.pop();
 }
 return lines;
}

function renderUnknown(): string[] {
 return ["Usage: /todos [ready|blocked|completed|archived|all|<id>]"];
}

function buildBlockedDepsMap(
 state: TaskState,
 blocked: readonly { id: number }[],
): DepMap {
 const map: DepMap = new Map();
 for (const t of blocked) {
  map.set(t.id, buildDependencyPresentation(state, t.id));
 }
 return map;
}

// ── P3-E core: load envelope ─────────────────────────────────────────

type LoadEnvelopeResult =
 | { ok: true; scope: ScopeKey; envelope: CurrentPersistedTodoEnvelope }
 | { ok: false; kind: "scope"; cause: ScopeResolutionError }
 | { ok: false; kind: "io"; message: string };

async function loadEnvelope(
 ctx: unknown,
 persistence: TodoRuntimePersistence,
): Promise<LoadEnvelopeResult> {
 let scope: ScopeKey;
 try {
  scope = await persistence.scopeResolver.resolve(ctx);
 } catch (cause) {
  if (cause instanceof Error && cause.name === "ScopeResolutionError") {
   return {
    ok: false,
    kind: "scope",
    cause: cause as ScopeResolutionError,
   };
  }
  return {
   ok: false,
   kind: "scope",
   cause: new ScopeResolutionError(String(cause)),
  };
 }
 try {
  const envelope = await persistence.durableStore.load(scope);
  // Successful load → update active scope ref (P3-E §28: presentation
  // identity = ScopeKey).
  setActiveScope(scope);
  return { ok: true, scope, envelope };
 } catch (cause) {
  return { ok: false, kind: "io", message: String(cause) };
 }
}

function reportLoadFailure(
 loaded:
  | { ok: false; kind: "scope"; cause: ScopeResolutionError }
  | { ok: false; kind: "io"; message: string },
 notify: (msg: string, level?: string) => void,
): void {
 if (loaded.kind === "scope") {
  notify(
   formatInfrastructureNotice(scopeResolutionToNotice(loaded.cause)),
   "error",
  );
  return;
 }
 notify(formatInfrastructureNotice({ kind: "io-failure" }), "error");
}

// ── P3-E core: runMutationFlow (durable wiring) ─────────────────────

interface UiNotify {
 notify: (msg: string, level?: string) => void;
}

async function runMutationFlow(
 raw: string,
 ctx: unknown,
 persistence: TodoRuntimePersistence,
 overlayCache: OverlaySnapshotCache,
): Promise<void> {
 const ui = (ctx as { ui: UiNotify }).ui;

 const parsed = parseMutationCommand(raw);
 if (parsed.ok === false) {
  ui.notify(
   formatMutationError({ kind: "command-syntax" }).join("\n"),
   "error",
  );
  return;
 }

 const loaded = await loadEnvelope(ctx, persistence);
 if (loaded.ok !== true) {
  reportLoadFailure(loaded, ui.notify);
  return;
 }
 const { scope, envelope } = loaded;
 const initial: TaskState = envelope.state;

 let planCommand: import("./types.ts").MutationCommand;
 let planTargetIds: readonly number[];
 if (isLifecycle(parsed.command)) {
  planCommand = parsed.command;
  planTargetIds = [parsed.command.id];
 } else {
  const ar = parsed.command;
  const sel = parseAndNormalizeSelector(ar.rawTokens);
  if (sel.ok === false) {
   ui.notify(
    formatMutationError({ kind: "selector-syntax", command: ar.kind }).join(
     "\n",
    ),
    "error",
   );
   return;
  }
  const arCommand: import("./types.ts").MutationCommand = {
   kind: ar.kind,
   selector: sel.selector,
  };
  const policy = validateMutationCommand(arCommand);
  if (policy.ok === false) {
   // P4-C2 LOCK 21: selector-policy rejection wording is owned by the
   // additive P4 `formatSelectorPolicyNotice` formatter. The frozen
   // policy itself (validateMutationCommand) is unchanged — only the
   // user-visible explanation is upgraded to actionable text. All
   // other P1 error kinds still use frozen `formatMutationError`.
   ui.notify(formatSelectorPolicyNotice(policy.error).join("\n"), "error");
   return;
  }
  if (arCommand.kind !== "archive" && arCommand.kind !== "restore") {
   // Exhaustiveness: archive/restore is the only selector-carrying branch.
   ui.notify(
    formatMutationError({ kind: "command-syntax" }).join("\n"),
    "error",
   );
   return;
  }
  const resolved = resolveSelectorIds(initial, arCommand.selector);
  if (resolved.ok === false) {
   ui.notify(
    formatMutationError({
     kind: "resolution",
     notFound: resolved.notFound,
    }).join("\n"),
    "error",
   );
   return;
  }
  planCommand = arCommand;
  planTargetIds = resolved.ids;
 }

 const plan = buildMutationPlan(planCommand, planTargetIds);

 // Empty semantic no-op short-circuit (LOCK §35).
 if (plan.targetIds.length === 0) {
  const noOpOutcome = buildMutationOutcome(initial, initial, plan);
  const noOpLines = formatMutationOutcome(noOpOutcome, DEFAULT_WIDTH);
  ui.notify(noOpLines.join("\n"), "info");
  return;
 }

 const observed = createObservedReduceContext();

 const result = applyMutationPlan(initial, plan, observed.reduceContext);
 if (result.ok === false) {
  ui.notify(
   formatMutationError({
    kind: "domain",
    error: result.error,
    failedTargetId: result.failedTargetId,
   }).join("\n"),
   "error",
  );
  return;
 }

 // Format BEFORE CAS (LOCK §34).
 const outcome = buildMutationOutcome(initial, result.next, plan);
 const lines = formatMutationOutcome(outcome, DEFAULT_WIDTH);

 // Provisional material (snapshot isolated, LOCK §38).
 const provisionalMaterial: ReplayMutationMaterial = {
  baseRevision: envelope.revision,
  revision: envelope.revision + 1,
  actions: structuredClone(plan.actions),
  replayContext: { nowValues: observed.snapshotNowValues() },
 };
 void provisionalMaterial;

 const commitResult = await persistence.durableStore.commit(
  scope,
  envelope.revision,
  result.next,
 );
 if (commitResult.kind === "conflict") {
  // Discard formatted text + provisional material (LOCK §21).
  ui.notify(
   formatInfrastructureNotice({
    kind: "cas-conflict",
    actualRevision: commitResult.actualRevision,
   }),
   "error",
  );
  return;
 }

 overlayCache.update(scope, commitResult.envelope);
 ui.notify(lines.join("\n"), "info");
}

// ── P3-E core: runGraphQuery (durable wiring) ────────────────────────

async function runGraphQuery(
 command: GraphCommand,
 ctx: unknown,
 persistence: TodoRuntimePersistence,
 overlayCache: OverlaySnapshotCache,
): Promise<void> {
 const ui = (ctx as { ui: UiNotify }).ui;

 const loaded = await loadEnvelope(ctx, persistence);
 if (loaded.ok !== true) {
  reportLoadFailure(loaded, ui.notify);
  return;
 }
 const { scope, envelope } = loaded;
 overlayCache.update(scope, envelope);

 const state = envelope.state;
 let lines: string[];
 switch (command.kind) {
  case "next":
   lines = formatNextTasks(queryNextTasks(state), DEFAULT_WIDTH);
   break;
  case "why":
   lines = formatWhyTask(queryWhyTask(state, command.id), DEFAULT_WIDTH);
   break;
  case "unlocks":
   lines = formatUnlocksTask(
    queryUnlocksTask(state, command.id),
    DEFAULT_WIDTH,
   );
   break;
 }
 ui.notify(lines.join("\n"), "info");
}

// ── P4-C2 core: runWorkflowQuery (workflow grammar dispatch) ───────

async function runWorkflowQuery(
 command: WorkflowCommand,
 ctx: unknown,
 persistence: TodoRuntimePersistence,
 overlayCache: OverlaySnapshotCache,
): Promise<void> {
 const ui = (ctx as { ui: UiNotify }).ui;

 // Same one-snapshot-per-command pattern as runGraphQuery (P3-E
 // authority boundary). Workflow command is read-only by definition
 // (LOCK 1) and consumes exactly one durable snapshot (LOCK 2).
 const loaded = await loadEnvelope(ctx, persistence);
 if (loaded.ok !== true) {
  reportLoadFailure(loaded, ui.notify);
  return;
 }
 const { scope, envelope } = loaded;
 overlayCache.update(scope, envelope);

 const state = envelope.state;
 let lines: string[];
 switch (command.kind) {
  case "here":
   // LOCK 3: derives roles/unlocks only through frozen P2-A
   // accessors. No reverse-dep inspection, no second
   // Status/State vocabulary (LOCK 20).
   lines = formatCurrentTask(state, DEFAULT_WIDTH);
   break;
 }
 ui.notify(lines.join("\n"), "info");
}

// ── v1.1: /todos read command (B3 + P4-C2 detail) ────────────────────

/**
 * B3 fallback read path: one durable snapshot → parse → render → notify.
 * Interactive runtimes use the task window; runtimes without custom UI
 * retain the same textual read output.
 */
async function runReadCommand(
 raw: unknown,
 ctx: unknown,
 persistence: TodoRuntimePersistence,
 overlayCache: OverlaySnapshotCache,
): Promise<void> {
 const ui = (ctx as { ui: UiNotify }).ui;
 const loaded = await loadEnvelope(ctx, persistence);
 if (loaded.ok !== true) {
  reportLoadFailure(loaded, ui.notify);
  return;
 }
 const { scope, envelope } = loaded;
 overlayCache.update(scope, envelope);
 const state = envelope.state;
 const parsed = parseTodosCommand(raw);
 let lines: string[];
 switch (parsed.command) {
  case "default":
   lines = renderDefault(state, DEFAULT_WIDTH);
   break;
  case "detail":
   lines = formatTaskDetailRich(state, parsed.taskId as number, DEFAULT_WIDTH);
   break;
  case "ready":
   lines = renderReady(state, DEFAULT_WIDTH);
   break;
  case "blocked":
   lines = renderBlocked(state, DEFAULT_WIDTH);
   break;
  case "completed":
   lines = renderCompleted(state, DEFAULT_WIDTH);
   break;
  case "archived":
   lines = renderArchived(state, DEFAULT_WIDTH);
   break;
  case "all":
   lines = renderAll(state, DEFAULT_WIDTH);
   break;
  case "unknown":
   lines = renderUnknown();
   break;
 }
 const level = parsed.command === "unknown" ? "error" : "info";
 ui.notify(lines.join("\n"), level);
}

// ── interactive task window ────────────────────────────────────────

interface TaskWindowUi {
 notify: (msg: string, level?: string) => void;
 custom?<T>(
  factory: (
   tui: TaskBrowserTui,
   theme: TaskBrowserTheme,
   keybindings: TaskBrowserKeybindings,
   done: (result: T) => void,
  ) => {
   render(width: number): string[];
   invalidate(): void;
   handleInput?(data: string): void;
  },
  options?: {
   overlay?: boolean;
   overlayOptions?: {
    anchor?: string;
    width?: string | number;
    maxHeight?: string | number;
    margin?: number;
   };
  },
 ): Promise<T>;
}

// ── minimal sid / foreground helpers (avoid store.ts) ─────────────

interface MinimalCtx {
 sessionManager?: { getSessionId(): string };
 hasUI: boolean;
 ui: UiNotify & {
  setWidget?(
   key: string,
   value: unknown,
   options?: { placement?: string },
  ): void;
 };
}

function sidFromCtx(ctx: unknown): string {
 const c = ctx as MinimalCtx;
 return c.sessionManager?.getSessionId() ?? "";
}

let fgSession = "";
function setFgSession(id: string): void {
 fgSession = id;
}
function getFgSession(): string {
 return fgSession;
}
function clearFgSession(_id: string): void {
 fgSession = "";
}
function evictScope(_id: string): void {
 // ScopeKey-keyed overlay cache eviction lives in the cache layer.
 // For v0 we clear foreground on shutdown.
}

/**
 * The ScopeKey most recently resolved by a successful loadEnvelope().
 * The overlay reads its presentation state from
 * OverlaySnapshotCache.getOrEmpty(activeScope) — this ref is the
 * sole source of "which scope is the foreground presentation scope".
 * Updated atomically with every successful durable load / commit.
 */
let activeScope: ScopeKey | undefined;
function setActiveScope(scope: ScopeKey): void {
 activeScope = scope;
}
function getActiveScope(): ScopeKey | undefined {
 return activeScope;
}
function clearActiveScope(): void {
 activeScope = undefined;
}

function formatError(e: unknown): string {
 return e instanceof Error ? e.message : String(e);
}

// ── factory ────────────────────────────────────────────────────────

export default function factory(
 pi: ExtensionAPI,
 options: FactoryOptions = {},
): void {
 const persistence = options.persistence ?? createProductionTodoPersistence();
 const overlayCache = new OverlaySnapshotCache();

 let overlay: TodoOverlay | undefined;
 let uiCtx: MinimalCtx["ui"] | undefined;
 const recoveryNotifiedScopes = new Set<string>();

 function refreshOverlay(): void {
  if (!uiCtx || !overlay) return;
  overlay.update();
 }

 function requestModelReview(task: { id: number; subject: string; description?: string; status: string; updatedAt: number }, ctx: unknown): void {
  const sendMessage = (pi as unknown as { sendMessage?: (message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean; deliverAs: "followUp" }) => void }).sendMessage;
  if (typeof sendMessage !== "function") {
   (ctx as { ui: UiNotify }).ui.notify("当前 Pi 版本不支持把任务交给模型判断。", "warning");
   return;
  }
  const details = [
   `任务 #${task.id}: ${sanitizeTerminalText(task.subject)}`,
   `状态: ${task.status}`,
   `最近更新: ${new Date(task.updatedAt).toISOString()}`,
   task.description ? `说明: ${sanitizeTerminalText(task.description)}` : "",
  ].filter(Boolean).join("\n");
  sendMessage({
   customType: "todo-recovery-review",
   display: false,
   content: [
    "请审查下面这个跨会话未结束的 todo 任务。只给出判断建议，不要调用 todo 工具，不要修改任何任务状态。",
    "请返回：继续 / 标记完成 / 关闭 / 无法判断，并说明依据；信息不足时必须选择无法判断。",
    details,
   ].join("\n\n"),
  }, { triggerTurn: true, deliverAs: "followUp" });
 }

 async function executeTodo(params: TaskMutationParams, ctx: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details?: TodoDetails }> {
   const loaded = await loadEnvelope(ctx, persistence);
   if (loaded.ok !== true) {
    return {
     content: [
      {
       type: "text",
       text: reportLoadFailureText(loaded),
      },
     ],
    };
   }
   const { scope, envelope } = loaded;
   const initial: TaskState = envelope.state;
   const paramsTyped = params as TaskMutationParams;
   const observed = createObservedReduceContext();
   const reducerResult = applyTaskMutation(
    initial,
    paramsTyped,
    observed.reduceContext,
   );
   if (reducerResult.op.kind === "error") {
    const text = formatContent(reducerResult.op, reducerResult.state);
    const details: TodoDetails = {
     tasks: reducerResult.state.tasks,
     nextId: reducerResult.state.nextId,
    };
    return { content: [{ type: "text", text }], details };
   }
   // Provisional material (LOCK §38).
   const provisionalMaterial: ReplayMutationMaterial = {
    baseRevision: envelope.revision,
    revision: envelope.revision + 1,
    actions: [structuredClone(paramsTyped)],
    replayContext: { nowValues: observed.snapshotNowValues() },
   };
   void provisionalMaterial;
   const commitResult = await persistence.durableStore.commit(
    scope,
    envelope.revision,
    reducerResult.state,
   );
   if (commitResult.kind === "conflict") {
    return {
     content: [
      {
       type: "text",
       text: formatInfrastructureNotice({
        kind: "cas-conflict",
        actualRevision: commitResult.actualRevision,
       }),
      },
     ],
    };
   }
   overlayCache.update(scope, commitResult.envelope);
   const text = formatContent(reducerResult.op, commitResult.envelope.state);
   const details: TodoDetails = {
    tasks: commitResult.envelope.state.tasks,
    nextId: commitResult.envelope.state.nextId,
   };
   return { content: [{ type: "text", text }], details };

 }

 /**
  * Interactive task window. Each pass renders one freshly loaded durable
  * snapshot. Mutations close only the focused component, commit through the
  * existing tool path, then reopen the same view and selection.
  */
 async function runTaskBrowser(
  ctx: unknown,
  initialView: TaskBrowserView = "current",
  initialDetailId?: number,
 ): Promise<void> {
  const ui = (ctx as { ui: TaskWindowUi }).ui;
  const custom = ui.custom?.bind(ui);
  if (typeof custom !== "function") {
   const fallback = initialDetailId === undefined
    ? initialView === "current" ? "" : initialView
    : String(initialDetailId);
   await runReadCommand(fallback, ctx, persistence, overlayCache);
   return;
  }

  const session: TaskBrowserSession = {
   view: initialView,
   query: "",
   detailId: initialDetailId,
   selectedId: initialDetailId,
   selectedIndex: 0,
  };

  overlay ??= new TodoOverlay(overlayCache, getActiveScope);
  overlay.setUICtx(ui as unknown as Parameters<TodoOverlay["setUICtx"]>[0]);
  overlay.setSuspended(true);

  try {
   while (true) {
    const loaded = await loadEnvelope(ctx, persistence);
    if (loaded.ok !== true) {
     reportLoadFailure(loaded, ui.notify);
     return;
    }
    overlayCache.update(loaded.scope, loaded.envelope);

    const intent = await custom(
     (tui, theme, keybindings, done) =>
      new TaskBrowserComponent(
       tui,
       theme,
       keybindings,
       loaded.envelope.state,
       session,
       done,
      ),
     {
      overlay: true,
      overlayOptions: {
       anchor: "center",
       width: "90%",
       maxHeight: "85%",
       margin: 1,
      },
     },
    ) as TaskBrowserIntent;

    if (intent.kind === "close") return;

    if (intent.kind === "action" && intent.action === "review") {
     const task = loaded.envelope.state.tasks.find((candidate) => candidate.id === intent.id);
     if (task) {
     requestModelReview(task, ctx);
      (ctx as { ui: UiNotify }).ui.notify("已把任务交给模型判断；模型不会直接修改任务状态。", "info");
     }
     return;
    }

    if (intent.kind === "action" && intent.action === "continue") {
     session.notice = { text: `任务 #${intent.id} 已保留为进行中，可以继续当前工作`, level: "info" };
     continue;
    }

    let params: TaskMutationParams;
    if (intent.kind === "create") {
     params = { action: "create", subject: intent.subject };
    } else if (intent.kind === "edit") {
     params = { action: "update", id: intent.id, subject: intent.subject };
    } else {
     params = { action: intent.action, id: intent.id };
    }

    try {
     const result = await executeTodo(params, ctx);
     const rawMessage = result.content[0]?.text ?? "";
     const message = sanitizeTerminalText(rawMessage.split("\n", 1)[0] ?? "").trim();
     const failed = message.startsWith("Error:") || result.details === undefined;
     session.notice = {
      text: truncateToWidth(message || (failed ? "操作失败" : "任务已更新"), 72),
      level: failed ? "error" : "info",
     };

     if (!failed && intent.kind === "create" && result.details) {
      const createdId = result.details.nextId - 1;
      session.selectedId = createdId;
      session.selectedIndex = result.details.tasks.findIndex((task) => task.id === createdId);
     } else if (intent.kind !== "create") {
      session.selectedId = intent.id;
     }
     if (intent.kind !== "edit") session.detailId = undefined;
    } catch (error) {
     session.notice = { text: sanitizeTerminalText(formatError(error)), level: "error" };
     session.detailId = undefined;
    }
   }
  } finally {
   overlay.setSuspended(false);
   refreshOverlay();
  }
 }

 // ── tool ──────────────────────────────────────────────────────────

 /** pi 0.85 component contract: tool renderCall/renderResult must
  *  return a full Component. The new MouseRegion wrapper (click-to-
  *  expand on tool rows) calls child.invalidate() unconditionally, so
  *  a bare { render } literal crashes the whole TUI with
  *  "this.child.invalidate is not a function" at startup render. */
 const toolLineComponent = (
  render: (width: number) => string[],
 ): ToolRenderComponent => ({ render, invalidate: () => {} });

 pi.registerTool({
  name: TOOL_NAME,
  label: "Todo",
  description:
   "Plan and track multi-step work as a task list. Actions: create, update (status/fields/dependencies), list, get, delete (tombstone), clear. When asked to plan or break down work, create todo items instead of writing them in text.",
  promptSnippet: DEFAULT_PROMPT_SNIPPET,
  promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
  parameters: TODO_PARAMS_SCHEMA,

  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => executeTodo(params as TaskMutationParams, ctx),

  renderCall(args, theme) {
   const a = args as {
    action?: string;
    subject?: string;
    id?: number;
    status?: string;
   };
   const what = a.subject
    ? ` ${sanitizeTerminalText(a.subject)}`
    : a.id === undefined
      ? ""
      : ` #${a.id}`;
   const extra = a.status ? ` → ${a.status}` : "";
   // v0.6: verb in muted so the dim rest doesn't bury the action.
   const call =
    theme.fg("dim", "todo ") +
    theme.fg("muted", sanitizeTerminalText(String(a.action ?? "?"))) +
    theme.fg("dim", `${what}${sanitizeTerminalText(extra)}`);
   return toolLineComponent((width: number) => [truncateToWidth(call, width)]);
  },

  renderResult(result, opts, theme) {
   // v0.6 rendering contract:
   //   collapsed — first line, colored by its leading marker
   //     (✓ success / ▶ accent / ○ muted / Error error), plus a muted
   //     "(+N)" hint when the result has more lines (list output).
   //   expanded — every line, each colored by its own marker, so a
   //     `todo list` reads with the same role colors as the overlay.
   // The LLM-facing text is untouched; this is display-only.
   const text = result?.content?.[0]?.text ?? "";
   const lines = String(text).split("\n").map(sanitizeTerminalText);
   const lineColor = (line: string): string => {
    if (line.startsWith("Error:")) return "error";
    if (line.startsWith("✓")) return "success";
    if (line.startsWith("▶")) return "accent";
    if (line.startsWith("○")) return "muted";
    return "text";
   };
   if (opts?.expanded) {
    return toolLineComponent((width: number) =>
     lines.map((l) => theme.fg(lineColor(l), truncateToWidth(l, width))),
    );
   }
   const first = lines[0] ?? "";
   let collapsed = theme.fg(lineColor(first), first);
   if (lines.length > 1) {
    collapsed += theme.fg("muted", ` (+${lines.length - 1})`);
   }
   return toolLineComponent((width: number) => [truncateToWidth(collapsed, width)]);
  },
 });

 // ── /todos command ──────────────────────────────────────────────

 pi.registerCommand(COMMAND_NAME, {
  description:
   "打开任务窗口，浏览、搜索、新增任务，并在详情中执行适用操作。",
  handler: async (args, ctx) => {
   if (!ctx.hasUI) {
    ctx.ui.notify("/todos requires interactive mode", "error");
    return;
   }

   if (String(args ?? "").trim().split(/\s+/)[0] === "display") {
    const mode = String(args).trim().split(/\s+/)[1];
    if (!["compact", "full", "hidden"].includes(mode ?? "")) {
     ctx.ui.notify("用法: /todos display compact|full|hidden（本次会话）", "info");
     return;
    }
    overlay ??= new TodoOverlay(overlayCache, getActiveScope);
    overlay.setMode(mode as "compact" | "full" | "hidden");
    ctx.ui.notify(`任务状态条：${mode}`, "info");
    return;
   }
   const firstToken = String(args ?? "")
    .trim()
    .split(/\s+/)[0];

   if (MUTATION_VERBS.has(firstToken)) {
    await runMutationFlow(args, ctx, persistence, overlayCache);
    return;
   }

   const graphParsed = parseGraphCommand(String(args ?? ""));
   if (graphParsed.kind === "syntax-error") {
    ctx.ui.notify(graphSyntaxUsage(graphParsed.verb), "error");
    return;
   }
   if (graphParsed.kind === "command") {
    await runGraphQuery(graphParsed.command, ctx, persistence, overlayCache);
    return;
   }

   // P4-C2: additive workflow grammar (currently just `here`).
   // LOCK 15/23/30: `here` is NOT a B3 verb — it lives one layer up.
   // LOCK 30: workflow syntax wording is owned by the additive P4
   // workflow-format.ts, not inline in index.ts.
   const workflowParsed = parseWorkflowCommand(String(args ?? ""));
   if (workflowParsed.kind === "syntax-error") {
    ctx.ui.notify(formatWorkflowSyntaxError(workflowParsed.verb), "error");
    return;
   }
   if (workflowParsed.kind === "command") {
    await runWorkflowQuery(
     workflowParsed.command,
     ctx,
     persistence,
     overlayCache,
    );
    return;
   }

   // The common read surfaces share one bounded task window. Expert graph,
   // workflow and mutation commands above keep their direct command paths.
   if (String(args ?? "").trim() === "") {
    await runTaskBrowser(ctx);
    return;
   }
   const parsed = parseTodosCommand(args);
   if (parsed.command === "detail") {
    await runTaskBrowser(ctx, "all", parsed.taskId);
    return;
   }
   if (
    parsed.command === "default" ||
    parsed.command === "ready" ||
    parsed.command === "blocked" ||
    parsed.command === "completed" ||
    parsed.command === "archived" ||
    parsed.command === "all"
   ) {
    await runTaskBrowser(
     ctx,
     parsed.command === "default" ? "current" : parsed.command,
    );
    return;
   }
   await runReadCommand(args, ctx, persistence, overlayCache);
  },
 });

 // ── lifecycle (NO replayFromBranch / replaceState — LOCK §26) ────

 pi.on("session_start", async (event, ctx) => {
  let id: string;
  try {
   id = sidFromCtx(ctx);
  } catch {
   return;
  }
  if (!ctx.hasUI) return;
  setFgSession(id);
  uiCtx = ctx.ui;
  overlay ??= new TodoOverlay(overlayCache, getActiveScope);
  // SAFETY: TodoOverlay.setUICtx takes a structurally-compatible UI
  // context; MinimalCtx["ui"] matches the runtime shape but TS cannot
  // prove it through the type alone.
  overlay.setUICtx(ctx.ui as unknown as Parameters<typeof overlay.setUICtx>[0]);

  // P4-C1: cold-start workspace bootstrap.
  //
  // Goal: on Pi startup or /reload, the overlay silently restores the
  // current workspace's durable snapshot so the user does not lose
  // current-task context. This is a presentation lifecycle read, NOT
  // a mutation, NOT a branch restoration (P3-E LOCK §26-27 preserved).
  //
  // Failure policy (best-effort):
  //   1. Clear activeScope FIRST so a previous session's stale scope
  //      cannot drive the overlay if this session's load fails.
  //   2. Resolve scope, load envelope, populate cache, set activeScope.
  //      On any failure the cache may retain the previous envelope,
  //      but activeScope stays undefined → overlay reads EMPTY_STATE
  //      and renders []. The cache is presentation projection only;
  //      canonical command reads (/todos, /todos ready, etc.) do
  //      their own durable load per P3-E authority boundary.
  //   3. No mutation or branch rewind. A new-session recovery hint may
  //      notify once when the loaded snapshot has unfinished work.
  //   4. refreshOverlay runs last, even if bootstrap failed, so the
  //      overlay widget always attempts registration with the
  //      current (post-clear) state.
  clearActiveScope();
  try {
   const scope = await persistence.scopeResolver.resolve(ctx);
   const envelope = await persistence.durableStore.load(scope);
   overlayCache.update(scope, envelope);
   setActiveScope(scope);
   const reason = (event as { reason?: unknown } | undefined)?.reason;
   const recoveryKey = `${id}\0${String(scope)}`;
   if (reason !== undefined && reason !== "reload" && !recoveryNotifiedScopes.has(recoveryKey)) {
    const unfinished = envelope.state.tasks.filter((task) => task.status === "in_progress" && task.closedAt === undefined && task.archivedAt === undefined);
    if (unfinished.length > 0) {
     recoveryNotifiedScopes.add(recoveryKey);
     const ids = unfinished.slice(0, 3).map((task) => `#${task.id}`).join("、");
     const suffix = unfinished.length > 3 ? ` 等 ${unfinished.length} 项` : "";
     ctx.ui.notify(`发现上次未结束的任务：${ids}${suffix}。打开 /todos，在详情中选择“继续任务 / 让模型判断 / 结束任务”。`, "info");
    }
   }
  } catch {
   // silent: overlay stays [], session startup continues. Cache may
   // still hold a previous-session envelope, but activeScope is
   // undefined so overlay reads EMPTY_STATE.
  }
  try {
   refreshOverlay();
  } catch (e) {
   console.warn(`[pi-todo] overlay refresh failed: ${formatError(e)}`);
  }
 });

 // session_compact / session_tree: NO state restoration. Overlay
 // refresh only. Branch history MUST NOT overwrite workspace todo
 // state (LOCK §26-27).
 pi.on("session_compact", async () => {
  try {
   refreshOverlay();
  } catch (refreshErr) {
   // best-effort: overlay refresh failures are non-fatal
   void refreshErr;
  }
 });
 pi.on("session_tree", async () => {
  try {
   refreshOverlay();
  } catch (refreshErr) {
   // best-effort: overlay refresh failures are non-fatal
   void refreshErr;
  }
 });

 pi.on("session_shutdown", async (_event, ctx) => {
  let id = "";
  try {
   id = sidFromCtx(ctx);
  } catch (sidErr) {
   // sid extraction is best-effort; if it fails we fall through with id="".
   void sidErr;
  }
  for (const key of recoveryNotifiedScopes) {
   if (key.startsWith(`${id}\0`)) recoveryNotifiedScopes.delete(key);
  }
  evictScope(id);
  if (id === "" || id === getFgSession()) {
   clearFgSession(id);
   clearActiveScope();
   try {
    overlay?.dispose();
   } finally {
    overlay = undefined;
    uiCtx = undefined;
   }
  }
 });

 pi.on("tool_execution_end", async (event) => {
  if (event.toolName !== TOOL_NAME || event.isError) return;
  refreshOverlay();
 });
}

function reportLoadFailureText(
 loaded:
  | { ok: false; kind: "scope"; cause: ScopeResolutionError }
  | { ok: false; kind: "io"; message: string },
): string {
 if (loaded.kind === "scope") {
  return formatInfrastructureNotice(scopeResolutionToNotice(loaded.cause));
 }
 return formatInfrastructureNotice({ kind: "io-failure" });
}
