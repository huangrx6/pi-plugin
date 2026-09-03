/**
 * pi-context-qos — non-destructive, task-aware working-context runtime.
 *
 * Pi's append-only session stays authoritative. This extension archives tool
 * evidence into a private SQLite + content-addressed zstd cold store, then uses
 * the `context` hook to choose RAW / EXTRACT / SUMMARY / TOMBSTONE representations
 * for old tool-result blocks. The newest causal frontier, user messages, pins,
 * unresolved failures, and current file snapshots are hard-protected.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ContextQosController,
  pressureLabel,
} from "./src/runtime/controller.ts";
import { textFromContent } from "./src/runtime/tokens.ts";
import type {
  ContextStats,
  LooseMessage,
  PressureLevel,
  StoredContextItem,
} from "./src/types.ts";

const CHECKPOINT_TYPE = "context-qos-checkpoint";
const STATUS_KEY = "context:qos";
const ANSI_RESET = "\x1b[0m";
const PRESSURE_ANSI: Record<PressureLevel, string> = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  orange: "\x1b[33m",
  red: "\x1b[31m",
  critical: "\x1b[1;31m",
};
const INTERNAL_TOOLS = new Set([
  "context_recall",
  "context_search",
  "context_pin",
  "context_unpin",
]);

const REF_SCHEMA = {
  type: "object",
  properties: {
    ref: { type: "string", description: "A ctx://item/<id> reference." },
  },
  required: ["ref"],
  additionalProperties: false,
} as const;

function lineComponent(line: string) {
  return {
    render: (_width: number) => [line],
    invalidate: () => {},
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Footer status, one compact line matching the quota-status idiom:
 *
 *   ⚡QoS 22%(绿) 活179k 省22.9k 库165项
 *
 * The pressure percentage and level are colour-coded by level
 * (green/yellow/orange/red, bold red for critical); frozen renders as
 * `(绿·冻结)`. Published under the `context:qos` key — aggregators
 * route context-prefixed statuses to a context-governance row.
 */
export function formatStatus(stats: ContextStats): string {
  // Minimal footer cell: icon + pressure percentage, level shown by COLOR
  // only (no level word, no token/item/cold breakdown — /context stats has
  // the full report). ◎ distinguishes it from the quota ⚡ prefix.
  const color = PRESSURE_ANSI[stats.pressure];
  const pct = (stats.pressureRatio * 100).toFixed(0);
  const frozenSuffix = stats.frozen ? "·冻结" : "";
  return `${color}◎QoS ${pct}%${frozenSuffix}${ANSI_RESET}`;
}

function itemLine(item: StoredContextItem): string {
  const flags = [
    item.pinned ? "pinned" : "",
    item.unresolved ? "unresolved" : "",
    item.duplicateOf ? "duplicate" : "",
  ].filter(Boolean);
  return [
    `ctx://item/${item.id}`,
    `${item.toolName}/${item.kind}`,
    `${item.tier}/${item.representation}`,
    item.filePath ?? "",
    flags.length ? `[${flags.join(",")}]` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function requireController(
  controller: ContextQosController | undefined,
): ContextQosController {
  if (!controller)
    throw new Error("pi-context-qos is not initialized for a session");
  return controller;
}

function visibleEntries(controller: ContextQosController, ctx: any): void {
  controller.setVisibleEntries(ctx.sessionManager.getBranch());
}

function publishStatus(controller: ContextQosController, ctx: any): void {
  // Status is best-effort: it must never break the context hook, so any
  // failure here is swallowed on purpose.
  try {
    ctx?.ui?.setStatus?.(STATUS_KEY, formatStatus(controller.stats()));
  } catch {
    // ignore — footer status is cosmetic
  }
}

function statsText(controller: ContextQosController, ctx: any): string {
  const stats = controller.stats([], ctx.model);
  const tiers = Object.entries(stats.byTier)
    .map(([tier, tokens]) => `${tier}=${formatTokens(tokens)}`)
    .join(" · ");
  return [
    `Context QoS ${pressureLabel(stats.pressure)} ${(stats.pressureRatio * 100).toFixed(1)}%${stats.frozen ? " · FROZEN" : ""}`,
    `Active ${formatTokens(stats.activeTokens)} · Raw ${formatTokens(stats.rawTokens)} · Saved ${formatTokens(stats.savedTokens)}`,
    `${stats.itemCount} items · Cold ${formatBytes(stats.coldBytes)}`,
    tiers,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /context interactive picker (no-args path)
// ---------------------------------------------------------------------------

/** One row of the /context picker: subcommand + Chinese explanation. */
type ContextSub = { name: string; desc: string; needsArg?: string };

/**
 * Every /context subcommand with a one-line Chinese explanation, so the
 * picker doubles as living documentation — no need to remember flags.
 * needsArg marks subcommands that require an argument; picking one from
 * the panel shows its usage instead of running it with an empty value.
 */
const CONTEXT_SUBS: ContextSub[] = [
  { name: "stats", desc: "压力统计：占用、tokens、冷库" },
  { name: "top", desc: "保留分最高的条目（拿 ctx://item 引用的入口）" },
  { name: "tree", desc: "按 tier 分组浏览全部条目" },
  { name: "tasks", desc: "当前任务目标" },
  { name: "epochs", desc: "epoch 冻结摘要" },
  { name: "inspect", desc: "单个条目详情", needsArg: "<ref>" },
  { name: "recall", desc: "召回原始内容到当前上下文", needsArg: "<ref>" },
  { name: "search", desc: "全文检索归档条目", needsArg: "<query>" },
  { name: "pin", desc: "固定条目，永不自动降级", needsArg: "<ref>" },
  { name: "unpin", desc: "解除固定", needsArg: "<ref>" },
  { name: "gc", desc: "清理过期数据（可加 --aggressive 深度清理）" },
  { name: "freeze", desc: "暂停自动降级（审计用）" },
  { name: "unfreeze", desc: "恢复自动降级" },
  { name: "doctor", desc: "诊断：库路径、会话、可见分支" },
  { name: "config", desc: "打印当前生效配置" },
  { name: "reset-session", desc: "重置本会话 QoS 元数据（不动 Pi 会话）" },
];

/**
 * Open the interactive picker. Returns the chosen subcommand, undefined
 * when the user cancelled, or null when the runtime has no ui.select and
 * the usage table was shown instead (caller should just return).
 */
async function pickSubcommand(ctx: any): Promise<string | null | undefined> {
  const options = CONTEXT_SUBS.map((s) => `${s.name} — ${s.desc}`);
  const select = ctx?.ui?.select?.bind(ctx.ui);
  if (typeof select !== "function") {
    ctx?.ui?.notify?.(
      `用法: /context <子命令>\n${CONTEXT_SUBS.map((s) => `  ${s.name} — ${s.desc}`).join("\n")}`,
      "info",
    );
    return null;
  }
  const choice = await select("Context QoS — 选择子命令", options);
  if (choice === undefined) return undefined;
  return String(choice).split(/\s+—/)[0]!.trim();
}

export default function (pi: ExtensionAPI): void {
  let controller: ContextQosController | undefined;
  let compactInFlight = false;
  let lastFailureNotice = 0;

  function reportFailure(ctx: any, operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pi-context-qos] ${operation} failed: ${message}`);
    const now = Date.now();
    if (ctx?.hasUI && now - lastFailureNotice > 30_000) {
      lastFailureNotice = now;
      ctx.ui.notify(
        `Context QoS ${operation} failed; Pi session is untouched. Run /context doctor.`,
        "error",
      );
    }
  }

  pi.registerTool({
    name: "context_recall",
    label: "Context recall",
    description:
      "Restore the archived raw content behind a ctx://item/<id> reference into the current working context. Old tool results whose text was replaced by `[... archived · restore: context_recall(ctx://item/N)]` (or `raw: context_recall(...)` under an extract/summary) can be brought back verbatim with this tool.",
    promptSnippet:
      "When an old tool result shows `[… archived · restore: context_recall(ctx://item/N)]` or `raw: context_recall(…)` and you need that evidence for the current task, call context_recall with that ref instead of guessing or re-running the tool.",
    parameters: REF_SCHEMA,
    async execute(_id, params) {
      const runtime = requireController(controller);
      const text = runtime.recall(String(params.ref));
      return { content: [{ type: "text", text }], details: {} };
    },
    renderCall(args, theme) {
      return lineComponent(
        theme.fg("dim", `context recall ${String(args.ref ?? "")}`),
      );
    },
    renderResult(result, _options, theme) {
      const firstText = result?.content?.find(
        (part: { type?: string }) => part.type === "text",
      );
      const text = firstText?.type === "text" ? firstText.text : "";
      return lineComponent(
        theme.fg("dim", `recalled ${formatTokens(text.length)} chars`),
      );
    },
  });

  // v0.2: context_search / context_pin / context_unpin are NO LONGER
  // registered as model tools. Live evidence across 17 sessions / 4482
  // items: zero model invocations of any of them — three dead tool
  // schemas taxing every request. The user-facing /context search|pin|
  // unpin commands are unchanged; the recovery loop (the one that
  // matters for the model) is context_recall + the self-describing
  // stubs emitted by representationText.

  pi.registerCommand("context", {
    description:
      "Inspect and operate Context QoS. Run with no args for an interactive picker with per-subcommand explanations.",
    handler: async (args, ctx) => {
      const runtime = requireController(controller);
      visibleEntries(runtime, ctx);
      let [sub = "stats", ...rest] = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      let value = rest.join(" ");

      // ── No-args path: interactive picker (each subcommand carries its
      // own Chinese explanation, so nothing has to be memorized). ──
      if (!String(args ?? "").trim()) {
        const picked = await pickSubcommand(ctx);
        if (picked === null) return; // usage table already shown
        if (picked === undefined) {
          ctx.ui.notify("已取消", "info");
          return;
        }
        sub = picked;
        rest = [];
        value = "";
        const spec = CONTEXT_SUBS.find((s) => s.name === sub);
        if (spec?.needsArg) {
          ctx.ui.notify(
            `${sub} 需要参数 ${spec.needsArg}\n` +
              `用法: /context ${sub} ${spec.needsArg}\n` +
              `先用 /context top 或 /context search 拿到 ctx://item/<id> 引用。`,
            "info",
          );
          return;
        }
      }

      let output = "";
      switch (sub) {
        case "stats":
        case "":
          output = statsText(runtime, ctx);
          break;
        case "top": {
          const items = runtime.db
            .listItems(runtime.session.id)
            .sort((a, b) => b.retentionScore - a.retentionScore)
            .slice(0, 12);
          output = items.length
            ? items.map(itemLine).join("\n")
            : "No context items.";
          break;
        }
        case "tree": {
          const groups = new Map<string, StoredContextItem[]>();
          for (const item of runtime.db.listItems(runtime.session.id)) {
            const list = groups.get(item.tier) ?? [];
            list.push(item);
            groups.set(item.tier, list);
          }
          output = [...groups]
            .map(
              ([tier, items]) =>
                `${tier}\n${items
                  .slice(-8)
                  .map((item) => `  ${itemLine(item)}`)
                  .join("\n")}`,
            )
            .join("\n");
          break;
        }
        case "tasks":
          output =
            runtime.db
              .listTasks(runtime.session.id)
              .map(
                (task) =>
                  `${task.status} · ${task.title} · turn ${task.created_turn}`,
              )
              .join("\n") || "No inferred task.";
          break;
        case "epochs":
          output = runtime.db
            .listEpochs(runtime.session.id)
            .map(
              (epoch) =>
                `#${epoch.ordinal} ${epoch.status} · turns ${epoch.start_turn}-${epoch.end_turn ?? "…"}`,
            )
            .join("\n");
          break;
        case "inspect": {
          const item = runtime.getItem(value);
          output = item
            ? `${itemLine(item)}\nraw=${formatTokens(item.rawTokens)} · active=${formatTokens(item.activeTokens)}\n${item.summaryText}`
            : `Context ref not found on this branch: ${value}`;
          break;
        }
        case "recall":
          output = runtime.recall(value);
          break;
        case "search": {
          const items = runtime.search(value);
          output = items.length
            ? items.map(itemLine).join("\n")
            : "No matches.";
          break;
        }
        case "pin":
        case "unpin":
          output = runtime.pin(value, sub === "pin")
            ? `${sub === "pin" ? "Pinned" : "Unpinned"} ${value}`
            : `Context ref not found on this branch: ${value}`;
          break;
        case "gc": {
          const result = runtime.gc(rest.includes("--aggressive"));
          output = `GC removed ${result.items} items and ${result.blobs} blobs (${formatBytes(result.bytes)}). Pi session untouched.`;
          break;
        }
        case "freeze":
        case "unfreeze":
          runtime.freeze(sub === "freeze");
          output = `Context transformations ${sub === "freeze" ? "frozen" : "resumed"}.`;
          break;
        case "doctor":
          output = [
            "Context QoS doctor: OK",
            `database: ${runtime.db.path}`,
            `blob store: ${runtime.blobs.root}`,
            `session: ${runtime.session.id}`,
            `visible branch entries: ${runtime.visibleEntryIds.size}`,
          ].join("\n");
          break;
        case "config":
          output = JSON.stringify(runtime.config, null, 2);
          break;
        case "reset-session":
          runtime.reset();
          output =
            "Context QoS metadata for this session was reset. Pi session and shared blobs were not deleted.";
          break;
        default:
          output = `Unknown subcommand: ${sub}`;
      }
      ctx.ui.notify(output, "info");
    },
  });

  pi.on("session_start", (event, ctx) => {
    try {
      controller?.close();
      const model = ctx.model as Record<string, unknown> | undefined;
      controller = new ContextQosController({
        id: ctx.sessionManager.getSessionId(),
        sessionPath: ctx.sessionManager.getSessionFile() ?? null,
        projectRoot: ctx.cwd,
        model:
          model && typeof model.id === "string"
            ? `${String(model.provider ?? "unknown")}/${model.id}`
            : null,
        contextWindow:
          model && typeof model.contextWindow === "number"
            ? model.contextWindow
            : null,
        projectTrusted: ctx.isProjectTrusted(),
      });
      visibleEntries(controller, ctx);
      if (
        event.reason === "fork" &&
        typeof event.previousSessionFile === "string"
      ) {
        controller.inheritFork(event.previousSessionFile);
      }
      // Publish immediately so the footer shows QoS from the very first
      // paint — the context hook only fires before model calls, which
      // would leave the status invisible until the first user turn.
      // On a resumed session this reflects the archived items; on a fresh
      // one it shows a zeroed-out line proving the runtime is alive.
      publishStatus(controller, ctx);
    } catch (error) {
      controller = undefined;
      reportFailure(ctx, "initialization", error);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      controller?.setObjective(event.prompt);
    } catch (error) {
      reportFailure(ctx, "task admission", error);
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    try {
      controller?.beginTurn();
    } catch (error) {
      reportFailure(ctx, "turn tracking", error);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!controller || INTERNAL_TOOLS.has(event.toolName)) return;
    const rawText = textFromContent(event.content);
    if (!rawText) return;
    try {
      visibleEntries(controller, ctx);
      controller.archiveToolResult({
        originEntryId: ctx.sessionManager.getLeafId(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolInput: event.input,
        rawText,
        isError: event.isError,
      });
    } catch (error) {
      reportFailure(ctx, "archive", error);
    }
  });

  pi.on("context", (event, ctx) => {
    if (!controller) return;
    try {
      visibleEntries(controller, ctx);
      const usage = ctx.getContextUsage();
      // SAFETY: the ambient shim types `event` as a loose record; the runtime
      // contract guarantees `messages` is the deep-copied provider message
      // array. planContext only reads role/toolCallId/content and returns
      // replacement messages, never mutating the input in place.
      const result = controller.plan(
        event.messages as unknown as LooseMessage[],
        usage?.tokens ?? null,
        ctx.model,
      );
      publishStatus(controller, ctx);
      if (
        result.level === "critical" &&
        result.overBudget &&
        controller.config.budget.nativeCompactFallback &&
        !compactInFlight
      ) {
        compactInFlight = true;
        ctx.compact({
          customInstructions:
            "Preserve the current user objective, explicit constraints, unresolved evidence, modified files, decisions, and ctx:// recall references.",
          onComplete: () => {
            compactInFlight = false;
          },
          onError: () => {
            compactInFlight = false;
          },
        });
      }
      return { messages: result.messages as any };
    } catch (error) {
      reportFailure(ctx, "planning", error);
      return;
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!controller) return;
    try {
      visibleEntries(controller, ctx);
      const nextEpoch = controller.maybeCloseEpoch();
      const state = controller.state();
      pi.appendEntry(CHECKPOINT_TYPE, {
        schemaVersion: 1,
        sessionId: controller.session.id,
        activeTaskId: state.activeTaskId,
        currentEpoch: nextEpoch ?? state.currentEpoch,
        turn: state.turn,
      });
    } catch (error) {
      reportFailure(ctx, "checkpoint", error);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    try {
      if (controller) visibleEntries(controller, ctx);
    } catch (error) {
      reportFailure(ctx, "tree rebuild", error);
    }
  });

  pi.on("session_compact", (_event, ctx) => {
    try {
      if (controller) visibleEntries(controller, ctx);
    } catch (error) {
      reportFailure(ctx, "compaction rebuild", error);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      controller?.close();
    } catch (error) {
      reportFailure(ctx, "shutdown", error);
    } finally {
      controller = undefined;
    }
  });
}
