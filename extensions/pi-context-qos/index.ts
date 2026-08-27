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
const STATUS_KEY = "usage:context-qos";
const ANSI_RESET = "\x1b[0m";
const PRESSURE_ANSI: Record<PressureLevel, string> = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  orange: "\x1b[33m",
  red: "\x1b[31m",
  critical: "\x1b[1;31m",
};
const PRESSURE_LABEL: Record<PressureLevel, string> = {
  green: "绿",
  yellow: "黄",
  orange: "橙",
  red: "红",
  critical: "危",
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

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Terms to search in the session cold store.",
    },
    limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
  },
  required: ["query"],
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
 * Footer status with Chinese labels, published as TWO lines:
 *
 *   QoS 上下文70%红 · 活621k · 省3.7k
 *   84项 · 冷181.8 KiB
 *
 * A status aggregator that renders multi-line cells gives each line
 * its own display row (indented under the row label); a single-line
 * renderer flattens the newline to a space. Published under the
 * `usage:context-qos` key.
 */
export function formatStatus(stats: ContextStats): string {
  const color = PRESSURE_ANSI[stats.pressure];
  const label = PRESSURE_LABEL[stats.pressure];
  const pct = `${(stats.pressureRatio * 100).toFixed(0)}%`;
  const head = `${color}QoS 上下文${pct}${label}${ANSI_RESET}`;
  const line1 = [
    head,
    `活${formatTokens(stats.activeTokens)}`,
    `省${formatTokens(stats.savedTokens)}`,
  ].join(" · ");
  const line2 = [
    `${stats.itemCount}项`,
    `冷${formatBytes(stats.coldBytes)}`,
    ...(stats.frozen ? ["冻结"] : []),
  ].join(" · ");
  return `${line1}\n${line2}`;
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
      "Restore the archived raw content behind a ctx://item/<id> reference into the current working context.",
    promptSnippet:
      "Use context_recall when an archived summary lacks evidence needed for the current task.",
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

  pi.registerTool({
    name: "context_search",
    label: "Context search",
    description:
      "Search archived context metadata and deterministic summaries in the current session branch using SQLite FTS5.",
    parameters: SEARCH_SCHEMA,
    async execute(_id, params) {
      const runtime = requireController(controller);
      const items = runtime.search(
        String(params.query),
        Number(params.limit ?? 8),
      );
      const text = items.length
        ? items.map(itemLine).join("\n")
        : "No archived context matched this query on the active branch.";
      return {
        content: [{ type: "text", text }],
        details: { count: items.length },
      };
    },
    renderCall(args, theme) {
      return lineComponent(
        theme.fg("dim", `context search ${String(args.query ?? "")}`),
      );
    },
  });

  for (const [name, pinned] of [
    ["context_pin", true],
    ["context_unpin", false],
  ] as const) {
    pi.registerTool({
      name,
      label: pinned ? "Context pin" : "Context unpin",
      description: `${pinned ? "Pin" : "Unpin"} an archived context item. Pinned items are never automatically downgraded.`,
      parameters: REF_SCHEMA,
      async execute(_id, params) {
        const runtime = requireController(controller);
        const ok = runtime.pin(String(params.ref), pinned);
        return {
          content: [
            {
              type: "text",
              text: ok
                ? `${pinned ? "Pinned" : "Unpinned"} ${String(params.ref)}`
                : `Context ref not found on this branch: ${String(params.ref)}`,
            },
          ],
          details: { pinned, found: ok },
        };
      },
      renderCall(args, theme) {
        return lineComponent(
          theme.fg(
            "dim",
            `${name.replace("context_", "context ")} ${String(args.ref ?? "")}`,
          ),
        );
      },
    });
  }

  pi.registerCommand("context", {
    description:
      "Inspect and operate Context QoS. Usage: /context [stats|top|tree|tasks|epochs|inspect|recall|search|pin|unpin|gc|freeze|unfreeze|doctor|config|reset-session]",
    handler: async (args, ctx) => {
      const runtime = requireController(controller);
      visibleEntries(runtime, ctx);
      const [sub = "stats", ...rest] = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const value = rest.join(" ");
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
