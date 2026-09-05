/**
 * pi-footer-composer — full bordered grid by default, compact rows optional.
 * Each grid cell holds one field or one published status; column widths are
 * shared across rows. grid.ts owns wrapping, alignment and quiet theme colors.
 * Data comes only from Pi's public session, context and footer surfaces.
 * `/footer native` restores Pi's built-in footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderTable, makeCell, sanitizeTerminalText } from "./layout.ts";
import type { Cell } from "./layout.ts";
import { renderGrid } from "./grid.ts";

type Theme = {
  fg(color: string, text: string): string;
  bold(t: string): string;
};
type FooterData = {
  getGitBranch: () => string | null;
  getExtensionStatuses: () => ReadonlyMap<string, string>;
  getAvailableProviderCount: () => number;
  onBranchChange: (callback: () => void) => () => void;
};
type Ctx = {
  sessionManager: {
    getEntries: () => readonly LooseEntry[];
    getCwd: () => string;
    getSessionName: () => string | null;
  };
  getContextUsage?: () =>
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
};

type LooseEntry = {
  type?: string;
  message?: { role?: string; usage?: LooseUsage };
  usage?: LooseUsage;
};
type LooseUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

const COMPACT_ROW_LABELS = ["路径", "模型", "状态"] as const;
type FooterMode = "compact" | "full" | "native";

// ── formatters (shared shape with the footer conventions) ──────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function sanitize(text: string): string {
  // Keep intentional \n (multi-line status cells — the renderer gives
  // each sub-line its own row); normalize every other kind of
  // whitespace and drop empty lines so a status can never inject
  // blank rows or trailing spaces into the footer.
  return sanitizeTerminalText(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

// ── cell builders ───────────────────────────────────────────────────────

function envCells(ctx: Ctx, footerData: FooterData, theme: Theme): Cell[] {
  const cells: Cell[] = [
    makeCell(theme.fg("text", sanitize(formatCwd(ctx.sessionManager.getCwd())))),
  ];
  const branch = footerData.getGitBranch();
  if (branch)
    cells.push(makeCell(theme.fg("text", sanitize(branch))));
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName)
    cells.push(makeCell(theme.fg("text", sanitize(sessionName))));
  return cells;
}

function usageCells(ctx: Ctx, theme: Theme): Cell[] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const u = entry.message.usage;
      if (!u) continue;
      totals.input += u.input ?? 0;
      totals.output += u.output ?? 0;
      totals.cacheRead += u.cacheRead ?? 0;
      totals.cacheWrite += u.cacheWrite ?? 0;
      totals.cost += u.cost?.total ?? 0;
      const promptTokens =
        (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      latestCacheHitRate =
        promptTokens > 0
          ? ((u.cacheRead ?? 0) / promptTokens) * 100
          : undefined;
    } else if (
      entry.type === "message" &&
      entry.message?.role === "toolResult"
    ) {
      const u = entry.message.usage;
      if (!u) continue;
      totals.input += u.input ?? 0;
      totals.output += u.output ?? 0;
      totals.cacheRead += u.cacheRead ?? 0;
      totals.cacheWrite += u.cacheWrite ?? 0;
      totals.cost += u.cost?.total ?? 0;
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      totals.input += entry.usage.input ?? 0;
      totals.output += entry.usage.output ?? 0;
      totals.cacheRead += entry.usage.cacheRead ?? 0;
      totals.cacheWrite += entry.usage.cacheWrite ?? 0;
      totals.cost += entry.usage.cost?.total ?? 0;
    }
  }
  const parts: string[] = [];
  if (totals.input) parts.push(`输入 ${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`输出 ${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`缓存读 ${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`缓存写 ${formatTokens(totals.cacheWrite)}`);
  if (
    (totals.cacheRead || totals.cacheWrite) &&
    latestCacheHitRate !== undefined
  )
    parts.push(`命中 ${latestCacheHitRate.toFixed(1)}%`);
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  return parts.map((p) => makeCell(theme.fg("text", p)));
}

function contextCell(
  ctx: Ctx,
  theme: Theme,
  model: { contextWindow?: number } | null,
  labelled = true,
): Cell[] {
  const usage = ctx.getContextUsage?.();
  const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
  const pct = typeof usage?.percent === "number" && Number.isFinite(usage.percent)
    ? usage.percent : undefined;
  const text =
    pct === null || pct === undefined
      ? `上下文 ? / ${window > 0 ? formatTokens(window) : "?"}`
      : `上下文 ${pct.toFixed(1)}% / ${window > 0 ? formatTokens(window) : "?"}`;
  const color =
    pct === null || pct === undefined
      ? "dim"
      : pct > 90
        ? "error"
        : pct > 70
          ? "warning"
          : "text";
  return [makeCell(theme.fg(color, labelled ? text : text.replace(/^上下文 /, "")))];
}

function modelCells(
  theme: Theme,
  model: { id?: string; provider?: string; reasoning?: boolean } | null,
  thinkingLevel: string | undefined,
  providerCount: number,
): Cell[] {
  const name = model?.id || "未选择模型";
  const cells = [makeCell(theme.fg("text", sanitize(name)))];
  if (providerCount > 1 && model?.provider)
    cells.push(makeCell(theme.fg("text", sanitize(model.provider))));
  if (model?.reasoning) {
    const level = thinkingLevel || "off";
    cells.push(makeCell(theme.fg("text", level === "off"
      ? "思考关闭" : `思考 ${sanitize(level)}`)));
  }
  return cells;
}

type Section =
  | "quota"
  | "usage"
  | "context"
  | "integration"
  | "config"
  | "misc";

/**
 * Map a status key to its footer row. Prefix convention preferred;
 * substring heuristic is a best-effort fallback for keys without the
 * prefix. Generic keywords only — no specific extension is named.
 */
function sectionOf(key: string): Section {
  if (key.startsWith("quota:")) return "quota";
  if (key.startsWith("usage:")) return "usage";
  if (key.startsWith("context:")) return "context";
  if (key.startsWith("integration:")) return "integration";
  if (key.startsWith("config:")) return "config";
  const k = key.toLowerCase();
  if (k === "mcp" || k.includes("lsp")) return "integration";
  if (k === "mode" || k.includes("policy")) return "config";
  if (k === "quota") return "quota";
  if (k.includes("context") || k.includes("qos")) return "context";
  return "misc";
}

/**
 * Bucket every published status into a footer row. Content-agnostic:
 * one cell per status, sorted by key for stable placement within a
 * row. Empty cells are dropped so a cleared status never wastes a
 * separator.
 */
function statusGroups(
  footerData: FooterData,
  theme: Theme,
  contextPercent?: number | null,
): Record<Section, Cell[]> {
  const groups: Record<Section, Cell[]> = {
    quota: [],
    usage: [],
    context: [],
    integration: [],
    config: [],
    misc: [],
  };
  const entries = Array.from(footerData.getExtensionStatuses().entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [key, text] of entries) {
    // Remove decorative leading pictographs only. Keep words, numbers and
    // meaningful warning/check symbols intact; never reinterpret status data.
    const clean = sanitize(text).split("\n").map(line =>
      line.replace(/^(?:[⚡🔌⚙◎]\uFE0F?\s*)+/u, ""),
    ).join("\n");
    const section = sectionOf(key);
    const contextSummary = section === "context"
      ? clean.match(/^(?:Context|上下文)\s+(\d+(?:\.\d+)?)%$/i) : null;
    if (contextSummary && typeof contextPercent === "number" &&
      Number.isFinite(contextPercent) &&
      Math.round(Number(contextSummary[1])) === Math.round(contextPercent)) continue;
    const cell = makeCell(clean ? theme.fg("text", clean) : "");
    if (cell.w === 0) continue;
    groups[section].push(cell);
  }
  return groups;
}

// ── extension entry ─────────────────────────────────────────────────────

type FooterTui = { requestRender(): void };
type FooterTheme = {
  fg(color: string, text: string): string;
  bold(t: string): string;
};
type FooterRenderer = (
  tui: FooterTui,
  theme: FooterTheme,
  footerData: FooterData,
) => {
  render(width: number): string[];
  invalidate(): void;
  dispose(): void;
};
type FooterCtx = Ctx & {
  model?: {
    id?: string;
    provider?: string;
    reasoning?: boolean;
    contextWindow?: number;
  } | null;
  thinkingLevel?: string;
  ui: {
    setFooter(renderer: FooterRenderer | undefined): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level?: string): void;
  };
};

export default function (pi: ExtensionAPI): void {
  let footerMode: FooterMode = "full";
  let activeCtx: Ctx | null = null;
  let activeModel: {
    id?: string;
    provider?: string;
    reasoning?: boolean;
    contextWindow?: number;
  } | null = null;
  let activeThinking: string | undefined;
  let requestRender: (() => void) | null = null;

  const mountFooter = (ctx: FooterCtx): void => {
    activeCtx = ctx;
    activeModel = ctx.model ?? null;
    activeThinking = ctx.thinkingLevel;
    requestRender = null;
    if (footerMode === "native") {
      ctx.ui.setFooter(undefined);
      return;
    }
    ctx.ui.setFooter(
      (tui: FooterTui, theme: FooterTheme, footerData: FooterData) => {
        requestRender = () => tui.requestRender();
        const unsubscribe = footerData.onBranchChange(() =>
          tui.requestRender(),
        );
        return {
          render: (width: number) => {
            const sections = statusGroups(footerData, theme, activeCtx?.getContextUsage?.()?.percent);
            if (footerMode === "compact") {
              return renderTable(
                [
                  envCells(activeCtx as Ctx, footerData, theme),
                  [
                    ...modelCells(
                      theme,
                      activeModel,
                      activeThinking,
                      footerData.getAvailableProviderCount(),
                    ),
                    ...sections.quota,
                  ],
                  [
                    ...contextCell(activeCtx as Ctx, theme, activeModel),
                    ...sections.context,
                    ...sections.config,
                    ...sections.misc,
                  ],
                ],
                width,
                theme,
                COMPACT_ROW_LABELS,
              );
            }
            const labelCells = (cells: Cell[], labels: string | string[]) =>
              cells.map((cell, index) => {
                const label = typeof labels === "string" ? labels : labels[index];
                return `${label ? `${label}  ` : ""}${cell.text}`;
              });
            return renderGrid(
              [
                ...labelCells(envCells(activeCtx as Ctx, footerData, theme), [
                  "路径", ...(footerData.getGitBranch() ? ["分支"] : []), "会话",
                ]),
                ...labelCells(modelCells(
                    theme,
                    activeModel,
                    activeThinking,
                    footerData.getAvailableProviderCount(),
                  ), ["模型", ...(activeModel?.provider && footerData.getAvailableProviderCount() > 1 ? ["平台"] : [])]),
                ...labelCells(sections.quota, "额度"),
                ...labelCells([
                  ...contextCell(activeCtx as Ctx, theme, activeModel, false),
                  ...sections.context,
                ], "窗口"),
                ...labelCells(usageCells(activeCtx as Ctx, theme), ""),
                ...labelCells(sections.usage, "累计"),
                ...labelCells(sections.integration, "集成"),
                ...labelCells([...sections.config, ...sections.misc], "状态"),
              ],
              width,
              theme,
            );
          },
          invalidate: () => {},
          dispose: () => {
            unsubscribe();
            requestRender = null;
          },
        };
      },
    );
  };

  const switchFooter = (mode: FooterMode, ctx: FooterCtx): void => {
    footerMode = mode;
    mountFooter(ctx);
    const label = mode === "compact" ? "紧凑" : mode === "full" ? "完整" : "Pi 原生";
    ctx.ui.notify(`Footer · ${label}`, "info");
  };

  pi.registerCommand("footer", {
    description: "切换紧凑、完整或 Pi 原生 Footer",
    handler: async (args: string, rawCtx: FooterCtx) => {
      const ctx = rawCtx as FooterCtx;
      const value = String(args ?? "").trim().toLowerCase();
      if (value === "compact" || value === "full" || value === "native") {
        switchFooter(value, ctx);
        return;
      }
      if (value) {
        ctx.ui.notify("用法: /footer compact|full|native", "error");
        return;
      }
      const choices = [
        "完整 · 默认，显示用量、集成与全部状态",
        "紧凑 · 收起累计用量和集成信息",
        "Pi 原生 · 停用自定义 Footer",
      ];
      const choice = await ctx.ui.select(
        `Footer（当前：${footerMode === "compact" ? "紧凑" : footerMode === "full" ? "完整" : "Pi 原生"}）`,
        choices,
      );
      if (choice === choices[0]) switchFooter("full", ctx);
      if (choice === choices[1]) switchFooter("compact", ctx);
      if (choice === choices[2]) switchFooter("native", ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Re-mount on every session_start: pi clears the custom footer on
    // session invalidate without firing session_shutdown.
    mountFooter(ctx as FooterCtx);
  });

  pi.on("model_select", async (event, ctx) => {
    activeModel = event.model ?? null;
    activeCtx = ctx as Ctx;
    requestRender?.();
  });

  pi.on("thinking_level_select", async (event) => {
    activeThinking = event.level;
    requestRender?.();
  });

  pi.on("turn_end", async () => {
    requestRender?.(); // usage totals changed
  });

  pi.on("session_shutdown", async () => {
    activeCtx = null;
    activeModel = null;
    activeThinking = undefined;
  });
}
