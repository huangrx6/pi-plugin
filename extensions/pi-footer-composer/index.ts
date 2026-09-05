/**
 * pi-footer-composer — compact grouped table by default, full rows optional.
 * Each category occupies one row with a shared label divider and open sides.
 * grid.ts owns wrapping, alignment and quiet theme colors.
 * Data comes only from Pi's public session, context and footer surfaces.
 * `/footer native` restores Pi's built-in footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { makeCell, sanitizeTerminalText } from "./layout.ts";
import type { Cell } from "./layout.ts";
import { renderGrid } from "./grid.ts";
import {
  createFooterConfigStore,
  DEFAULT_FOOTER_CONFIG,
  type FooterConfigStore,
  type FooterMode,
} from "./config.ts";

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

type UsageStats = {
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  latestCacheHitRate?: number;
};

function collectUsageStats(ctx: Ctx): UsageStats {
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
  return { totals, latestCacheHitRate };
}

function cacheHitText(stats: UsageStats): string | undefined {
  if (
    !(stats.totals.cacheRead || stats.totals.cacheWrite) ||
    stats.latestCacheHitRate === undefined
  ) return undefined;
  return `命中 ${stats.latestCacheHitRate.toFixed(1)}%`;
}

function cacheHitCells(stats: UsageStats, theme: Theme): Cell[] {
  const text = cacheHitText(stats);
  return text ? [makeCell(theme.fg("text", text))] : [];
}

function usageCells(stats: UsageStats, theme: Theme): Cell[] {
  const { totals } = stats;
  const parts: string[] = [];
  if (totals.input) parts.push(`输入 ${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`输出 ${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`缓存读 ${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`缓存写 ${formatTokens(totals.cacheWrite)}`);
  const cacheHit = cacheHitText(stats);
  if (cacheHit) parts.push(cacheHit);
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  return parts.map((part) => makeCell(theme.fg("text", part)));
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
    if (!clean) continue;
    groups[section].push(makeCell(theme.fg("text", clean)));
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

type FactoryOptions = { configStore?: FooterConfigStore };

export default function (pi: ExtensionAPI, options: FactoryOptions = {}): void {
  const configStore = options.configStore ?? createFooterConfigStore();
  let footerMode: FooterMode = DEFAULT_FOOTER_CONFIG.mode;
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
            const usage = collectUsageStats(activeCtx as Ctx);
            const labelCells = (cells: Cell[], labels: string | string[]) =>
              cells.map((cell, index) => {
                const label = typeof labels === "string" ? labels : labels[index];
                return `${label ? `${label}  ` : ""}${cell.text}`;
              });
            const environmentItems = () => labelCells(
              envCells(activeCtx as Ctx, footerData, theme),
              ["", ...(footerData.getGitBranch() ? ["分支"] : []), "会话"],
            );
            const modelItems = () => labelCells(
              modelCells(
                theme,
                activeModel,
                activeThinking,
                footerData.getAvailableProviderCount(),
              ),
              ["", ...(activeModel?.provider && footerData.getAvailableProviderCount() > 1
                ? ["平台"] : [])],
            );
            if (footerMode === "compact") {
              return renderGrid([
                { label: "路径", items: environmentItems() },
                { label: "模型", items: [
                  ...modelItems(),
                  ...labelCells(sections.quota, "额度"),
                ] },
                { label: "状态", items: labelCells([
                    ...contextCell(activeCtx as Ctx, theme, activeModel),
                    ...cacheHitCells(usage, theme),
                    ...sections.context,
                    ...sections.config,
                    ...sections.misc,
                  ], "") },
                ],
                width,
                theme,
              );
            }
            return renderGrid([
                { label: "路径", items: environmentItems() },
                { label: "模型", items: modelItems() },
                { label: "额度", items: labelCells(sections.quota, "") },
                { label: "窗口", items: labelCells([
                  ...contextCell(activeCtx as Ctx, theme, activeModel, false),
                  ...sections.context,
                ], "") },
                { label: "用量", items: labelCells([...usageCells(usage, theme), ...sections.usage], "") },
                { label: "集成", items: labelCells(sections.integration, "") },
                { label: "状态", items: labelCells([...sections.config, ...sections.misc], "") },
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
    try {
      configStore.save({ mode });
      ctx.ui.notify(`Footer · ${label} · 已保存`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Footer 已切换为${label}，但配置保存失败：${message}`, "warning");
    }
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
        "紧凑 · 默认，保留日常关键信息",
        "完整 · 显示用量、集成与全部状态",
        "Pi 原生 · 停用自定义 Footer",
      ];
      const choice = await ctx.ui.select(
        `Footer（当前：${footerMode === "compact" ? "紧凑" : footerMode === "full" ? "完整" : "Pi 原生"}）`,
        choices,
      );
      if (choice === choices[0]) switchFooter("compact", ctx);
      if (choice === choices[1]) switchFooter("full", ctx);
      if (choice === choices[2]) switchFooter("native", ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Re-mount on every session_start: pi clears the custom footer on
    // session invalidate without firing session_shutdown.
    const footerCtx = ctx as FooterCtx;
    try {
      footerMode = configStore.load().mode;
    } catch (error) {
      footerMode = DEFAULT_FOOTER_CONFIG.mode;
      const message = error instanceof Error ? error.message : String(error);
      footerCtx.ui.notify(`Footer 配置无效，已使用紧凑模式：${message}`, "warning");
    }
    mountFooter(footerCtx);
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
