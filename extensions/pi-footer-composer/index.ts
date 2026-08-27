/**
 * pi-footer-composer — five labelled rows, single responsibility.
 *
 * The ONLY footer owner in a setup: calls ctx.ui.setFooter() once and
 * renders the whole footer as a single column. Five content rows,
 * each prefixed with a dim category label glued to the first cell:
 *
 *   1. 环境   cwd / branch / session name (one dim cell each)
 *   2. 模型   (provider) id + thinking level
 *   3. 资源   ↑↓RW tokens · cache hit · $ cost · context % ·
 *            + any status whose key starts with "usage:" (e.g. quota)
 *   4. 集成   statuses whose key starts with "integration:"
 *            (e.g. MCP server count, LSP status)
 *   5. 配置   statuses whose key starts with "config:" (e.g. mode,
 *            policy) — also catches any uncategorised status as a
 *            fallback so nothing is silently dropped
 *
 * Cells within a row are joined by a dim `│`; a row wider than the
 * terminal greedy-wraps onto continuation lines, which are indented
 * under the label so the content stays aligned. Everything it shows
 * comes from pi's aggregate surfaces — it never imports or knows about
 * any other extension:
 *
 *   - ctx.sessionManager            cwd / session name / usage entries
 *   - ctx.getContextUsage()         context window occupancy
 *   - footerData                    git branch / available-provider count
 *   - footerData.getExtensionStatuses()   every extension's published
 *                                        status text, one CELL each —
 *                                        content-agnostic by design
 *
 * ## Status key → row routing
 *
 * Sections use a key-prefix convention (the documented API):
 *   "usage:<key>"          → 资源 row (line 3)
 *   "integration:<key>"    → 集成 row (line 4)
 *   "config:<key>"         → 配置 row (line 5)
 *
 * A small substring heuristic covers keys without the prefix for
 * backward compatibility with packages that haven't adopted the
 * convention yet — exact `mcp` or substring `lsp` → integration,
 * exact `mode` or substring `policy` → config, exact `quota` →
 * usage. Anything else falls through to the config row as "misc"
 * so it is never silently dropped.
 *
 * This also means installing another setFooter-calling extension will
 * conflict (pi replaces rather than composes footers); this extension
 * documents itself as the designated footer renderer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderTable, makeCell } from "./layout.ts";
import type { Cell } from "./layout.ts";

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

/**
 * Fixed row labels, in row order. Each label is a 2-CJK-char category
 * plus a full-width colon, glued to the first cell of that row's
 * content. The set is closed — adding/removing a row requires
 * editing both this array and the `renderTable` call below.
 */
const ROW_LABELS = ["环境：", "模型：", "资源：", "集成：", "配置："] as const;

// ── formatters (shared shape with the footer conventions) ──────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function sanitize(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
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
    makeCell(theme.fg("dim", formatCwd(ctx.sessionManager.getCwd()))),
  ];
  const branch = footerData.getGitBranch();
  if (branch) cells.push(makeCell(theme.fg("dim", `(${branch})`)));
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) cells.push(makeCell(theme.fg("dim", `• ${sessionName}`)));
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
  if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (
    (totals.cacheRead || totals.cacheWrite) &&
    latestCacheHitRate !== undefined
  )
    parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  return parts.map((p) => makeCell(theme.fg("dim", p)));
}

function contextCell(
  ctx: Ctx,
  theme: Theme,
  model: { contextWindow?: number } | null,
): Cell[] {
  const usage = ctx.getContextUsage?.();
  const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
  const pct = usage?.percent;
  const text =
    pct === null || pct === undefined
      ? `?/${formatTokens(window)}`
      : `${pct.toFixed(1)}%/${formatTokens(window)}`;
  const color =
    pct === null || pct === undefined
      ? "dim"
      : pct > 90
        ? "error"
        : pct > 70
          ? "warning"
          : "dim";
  return [makeCell(theme.fg(color, text))];
}

function modelCells(
  theme: Theme,
  model: { id?: string; provider?: string; reasoning?: boolean } | null,
  thinkingLevel: string | undefined,
  providerCount: number,
): Cell[] {
  const name = model?.id || "no-model";
  let text = name;
  if (model?.reasoning) {
    const level = thinkingLevel || "off";
    text = level === "off" ? `${name} (thinking off)` : `${name} (${level})`;
  }
  if (providerCount > 1 && model?.provider)
    text = `(${model.provider}) ${text}`;
  return [makeCell(theme.fg("dim", text))];
}

type Section = "usage" | "integration" | "config" | "misc";

/**
 * Map a status key to its footer row. Prefix convention preferred;
 * substring heuristic is a best-effort fallback for keys without the
 * prefix. Generic keywords only — no specific extension is named.
 */
function sectionOf(key: string): Section {
  if (key.startsWith("usage:")) return "usage";
  if (key.startsWith("integration:")) return "integration";
  if (key.startsWith("config:")) return "config";
  const k = key.toLowerCase();
  if (k === "mcp" || k.includes("lsp")) return "integration";
  if (k === "mode" || k.includes("policy")) return "config";
  if (k === "quota") return "usage";
  return "misc";
}

/**
 * Bucket every published status into a footer row. Content-agnostic:
 * one cell per status, sorted by key for stable placement within a
 * row. Empty cells are dropped so a cleared status never wastes a
 * separator.
 */
function statusGroups(footerData: FooterData): Record<Section, Cell[]> {
  const groups: Record<Section, Cell[]> = {
    usage: [],
    integration: [],
    config: [],
    misc: [],
  };
  const entries = Array.from(footerData.getExtensionStatuses().entries()).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [key, text] of entries) {
    const cell = makeCell(sanitize(text));
    if (cell.w === 0) continue;
    groups[sectionOf(key)].push(cell);
  }
  return groups;
}

// ── extension entry ─────────────────────────────────────────────────────

type FooterTui = { requestRender(): void };
type FooterTheme = {
  fg(color: string, text: string): string;
  bold(t: string): string;
};

export default function (pi: ExtensionAPI): void {
  let activeCtx: Ctx | null = null;
  let activeModel: {
    id?: string;
    provider?: string;
    reasoning?: boolean;
    contextWindow?: number;
  } | null = null;
  let activeThinking: string | undefined;
  let requestRender: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    // Re-mount on every session_start: pi clears the custom footer on
    // session invalidate without firing session_shutdown.
    activeCtx = ctx as Ctx;
    activeModel = (ctx as { model?: typeof activeModel }).model ?? null;
    activeThinking = (ctx as { thinkingLevel?: string }).thinkingLevel;
    ctx.ui.setFooter(
      (tui: FooterTui, theme: FooterTheme, footerData: FooterData) => {
        requestRender = () => tui.requestRender();
        const unsubscribe = footerData.onBranchChange(() =>
          tui.requestRender(),
        );
        return {
          render: (width: number) => {
            const sections = statusGroups(footerData);
            return renderTable(
              [
                // row 1: 环境 — cwd · branch · session
                envCells(activeCtx as Ctx, footerData, theme),
                // row 2: 模型 — provider · id · thinking
                modelCells(
                  theme,
                  activeModel,
                  activeThinking,
                  footerData.getAvailableProviderCount(),
                ),
                // row 3: 资源 — tokens · cache · cost · context · usage-prefixed statuses (quota)
                [
                  ...usageCells(activeCtx as Ctx, theme),
                  ...contextCell(activeCtx as Ctx, theme, activeModel),
                  ...sections.usage,
                ],
                // row 4: 集成 — integration-prefixed statuses (MCP, LSP)
                sections.integration,
                // row 5: 配置 — config-prefixed statuses (mode, policy) + misc fallback
                [...sections.config, ...sections.misc],
              ],
              width,
              theme,
              ROW_LABELS,
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
