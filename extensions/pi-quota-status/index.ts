/**
 * pi-quota-status — AI subscription quota monitor
 *
 * Shows remaining usage in the footer, below the model and right-aligned.
 * Auto-switches between OpenCode Go and Zhipu GLM based on current model.
 *
 * Pure event-driven (no setInterval → no stale-ctx crash).
 * Uses a custom footer so quota can share the status row below the model.
 *
 * Robustness notes:
 *  - The footer is re-mounted on every session_start: pi clears the custom
 *    footer on session invalidate without firing session_shutdown, so a
 *    mount-once flag would leave the footer gone forever. setExtensionFooter
 *    is replace-style (disposes the previous footer), making re-mount safe.
 *  - Fetches are serialized by a request sequence guard: a stale in-flight
 *    response can never overwrite newer data (fast model switching).
 *  - On fetch failure, the last good data is kept for STALE_KEEP_MS so
 *    transient network errors don't blank the footer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WIDGET_KEY = "quota";
const TURN_THROTTLE_MS = 10 * 1000;
const TREE_THROTTLE_MS = 5 * 1000;
/** How long to keep showing the last good data after a fetch error. */
const STALE_KEEP_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;

const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const ZHIPU_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

type Subscription = "opencode" | "zhipu";

const PROVIDER_SUBSCRIPTION: Record<string, Subscription> = {
  "opencode-go": "opencode",
  "zai-coding-cn": "zhipu",
};

const SUBSCRIPTION_DISPLAY: Record<Subscription, string> = {
  opencode: "⚡OC",
  zhipu: "⚡GLM",
};

// ANSI color codes (universal terminal support, no pi-tui dependency)
const C = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

type FooterTheme = {
  fg: (color: string, text: string) => string;
};

type FooterData = {
  getGitBranch: () => string | null;
  getExtensionStatuses: () => ReadonlyMap<string, string>;
  getAvailableProviderCount: () => number;
  onBranchChange: (callback: () => void) => () => void;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuotaCtx = ExtensionContext & {
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
};

type ModelLike = { provider?: string; id?: string } | undefined | null;

type QuotaWindow = { label: string; percent: number; resetsInMs: number };
type QuotaData = { provider: string; windows: QuotaWindow[] };

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 0) return "reset";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function colorForPercent(pct: number): string {
  if (pct >= 80) return C.red;
  if (pct >= 50) return C.yellow;
  return C.green;
}

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const ANSI_ONCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  if (/\p{Extended_Pictographic}/u.test(segment)) return 2;
  const code = segment.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) ? 2 : 1;
}

function visibleWidth(text: string): number {
  const clean = text.replace(ANSI_PATTERN, "").replace(/\t/g, "   ");
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) width += graphemeWidth(segment);
  return width;
}

function truncateToWidth(text: string, maxWidth: number, ellipsis = "..."): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const suffix = visibleWidth(ellipsis) <= maxWidth ? ellipsis : "";
  const targetWidth = maxWidth - visibleWidth(suffix);
  let result = "";
  let usedWidth = 0;
  let cursor = 0;

  // Use a non-global regex so there is no lastIndex state to reset/pollute.
  for (let match = ANSI_ONCE.exec(text); match; match = ANSI_ONCE.exec(text)) {
    const plain = text.slice(cursor, match.index);
    for (const { segment } of graphemeSegmenter.segment(plain)) {
      const width = graphemeWidth(segment);
      if (usedWidth + width > targetWidth) return result + suffix + C.reset;
      result += segment;
      usedWidth += width;
    }
    result += match[0];
    cursor = match.index + match[0].length;
  }

  for (const { segment } of graphemeSegmenter.segment(text.slice(cursor))) {
    const width = graphemeWidth(segment);
    if (usedWidth + width > targetWidth) break;
    result += segment;
    usedWidth += width;
  }
  return result + suffix + C.reset;
}

/** Build the colored quota text from cached data. */
function buildQuotaText(): string | null {
  if (errorText) {
    return `${C.red}${errorText}${C.reset}`;
  }
  if (!quotaData) return null;
  const staleSuffix = quotaFetchedAt > 0 && Date.now() - quotaFetchedAt > STALE_KEEP_MS
    ? `${C.dim}?${C.reset}`
    : "";
  const parts = quotaData.windows.map((w) => {
    const color = colorForPercent(w.percent);
    return `${color}${w.label}${w.percent}%${C.reset}${C.dim}(${formatDuration(w.resetsInMs)})${C.reset}`;
  });
  const tag = `${C.dim}${quotaData.provider}${C.reset}`;
  return `${tag} ${parts.join(" ")}${staleSuffix}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

function addUsage(
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
  usage: UsageLike | undefined,
): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

function renderFooter(
  ctx: QuotaCtx,
  model: ExtensionContext["model"],
  thinkingLevel: ExtensionContext["thinkingLevel"],
  footerData: FooterData,
  theme: FooterTheme,
  width: number,
): string[] {
  const entries = ctx.sessionManager.getEntries();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage as UsageLike;
      addUsage(totals, usage);
      const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      addUsage(totals, entry.message.usage as UsageLike | undefined);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsage(totals, entry.usage as UsageLike);
    }
  }

  let pwd = formatCwd(ctx.sessionManager.getCwd());
  const branch = footerData.getGitBranch();
  if (branch) pwd += ` (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) pwd += ` • ${sessionName}`;
  const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

  const statsParts: string[] = [];
  if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

  const contextUsage = ctx.getContextUsage?.();
  const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined
    ? "?"
    : contextUsage.percent.toFixed(1);
  const contextDisplay = contextPercent === "?"
    ? `?/${formatTokens(contextWindow)} (auto)`
    : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
  statsParts.push(contextDisplay);

  let statsLeft = statsParts.join(" ");
  if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");

  const modelName = model?.id || "no-model";
  let modelText = modelName;
  if (model?.reasoning) {
    const thinking = thinkingLevel || "off";
    modelText = thinking === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinking}`;
  }
  if (footerData.getAvailableProviderCount() > 1 && model) {
    const withProvider = `(${model.provider}) ${modelText}`;
    if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) modelText = withProvider;
  }

  const availableForModel = width - visibleWidth(statsLeft) - 2;
  if (availableForModel <= 0) {
    modelText = "";
  } else if (visibleWidth(modelText) > availableForModel) {
    modelText = truncateToWidth(modelText, availableForModel, "");
  }
  const statsPad = " ".repeat(Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(modelText)));
  const statsLine = theme.fg("dim", statsLeft + statsPad + modelText);

  const quota = buildQuotaText();
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .filter(Boolean)
    .join(" ");
  if (!quota) {
    return statuses
      ? [pwdLine, statsLine, truncateToWidth(statuses, width, theme.fg("dim", "..."))]
      : [pwdLine, statsLine];
  }

  const quotaWidth = visibleWidth(quota);
  if (quotaWidth >= width) return [pwdLine, statsLine, truncateToWidth(quota, width, "")];

  const statusWidth = Math.max(0, width - quotaWidth - (statuses ? 2 : 0));
  const statusLeft = statuses ? truncateToWidth(statuses, statusWidth, theme.fg("dim", "...")) : "";
  const quotaPad = " ".repeat(width - visibleWidth(statusLeft) - quotaWidth);
  return [pwdLine, statsLine, statusLeft + quotaPad + quota];
}

// ---------------------------------------------------------------------------
// API clients
// ---------------------------------------------------------------------------

async function fetchOpencodeUsage(apiKey: string): Promise<QuotaData> {
  const resp = await fetch(OPENCODE_USAGE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    usage: {
      rolling: { percent: number; resetsAt: string };
      weekly: { percent: number; resetsAt: string };
      monthly: { percent: number; resetsAt: string };
    };
  };
  const now = Date.now();
  const win = (label: string, w: { percent: number; resetsAt: string }): QuotaWindow => ({
    label, percent: w.percent, resetsInMs: new Date(w.resetsAt).getTime() - now,
  });
  return {
    provider: SUBSCRIPTION_DISPLAY.opencode,
    windows: [win("5h:", json.usage.rolling), win("周:", json.usage.weekly), win("月:", json.usage.monthly)],
  };
}

async function fetchZhipuQuota(apiKey: string): Promise<QuotaData> {
  const resp = await fetch(ZHIPU_QUOTA_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = (await resp.json()) as {
    data: { limits: { type: string; unit?: number | null; percentage: number; nextResetTime: number }[] };
  };
  const now = Date.now();
  const limits = json.data?.limits ?? [];
  const find = (unit: number) => limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === unit);
  const windows: QuotaWindow[] = [];
  const fh = find(3);
  const wk = find(6);
  if (fh) windows.push({ label: "5h:", percent: fh.percentage ?? 0, resetsInMs: fh.nextResetTime - now });
  if (wk) windows.push({ label: "周:", percent: wk.percentage ?? 0, resetsInMs: wk.nextResetTime - now });
  return { provider: SUBSCRIPTION_DISPLAY.zhipu, windows };
}

// ---------------------------------------------------------------------------
// Module-level state (updated by events, read by the footer component)
// ---------------------------------------------------------------------------

let quotaData: QuotaData | null = null;
let quotaFetchedAt = 0;
let errorText = "";
let lastRefreshAt = 0;
/** Sequence guard: only the newest request may write state. */
let fetchSeq = 0;
let activeFooterCtx: QuotaCtx | null = null;
let activeModel: ExtensionContext["model"];
let activeThinkingLevel: ExtensionContext["thinkingLevel"];
let requestFooterRender: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  function subscriptionForProvider(provider: string | undefined): Subscription | null {
    if (!provider) return null;
    return PROVIDER_SUBSCRIPTION[provider] ?? null;
  }

  function mountFooter(ctx: QuotaCtx): void {
    // Re-mount on every session_start: pi clears the custom footer on
    // session invalidate (without firing session_shutdown), so a mount-once
    // flag would leave the footer gone after a session switch. Re-setting is
    // safe — setExtensionFooter disposes the previous footer first.
    activeFooterCtx = ctx;
    activeModel = ctx.model;
    activeThinkingLevel = ctx.thinkingLevel;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestFooterRender);
      return {
        render: (width: number) => renderFooter(
          activeFooterCtx ?? ctx,
          activeModel,
          activeThinkingLevel,
          footerData,
          theme,
          width,
        ),
        invalidate: () => {},
        dispose: () => {
          unsubscribe();
          requestFooterRender = null;
        },
      };
    });
  }

  function updateFooter(ctx: QuotaCtx): void {
    activeFooterCtx = ctx;
    requestFooterRender?.();
  }

  async function refreshQuota(ctx: QuotaCtx, model: ModelLike): Promise<void> {
    const provider = model?.provider;
    const sub = subscriptionForProvider(provider);
    if (!sub) {
      // Unknown/no provider: clear everything (no stale fallback wanted).
      quotaData = null;
      quotaFetchedAt = 0;
      errorText = "";
      updateFooter(ctx);
      return;
    }
    let apiKey: string | undefined;
    if (sub === "opencode") apiKey = process.env.OPENCODE_API_KEY;
    else if (sub === "zhipu") apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) {
      quotaData = null;
      quotaFetchedAt = 0;
      errorText = `⚠ ${SUBSCRIPTION_DISPLAY[sub]} 无 Key`;
      updateFooter(ctx);
      return;
    }

    const seq = ++fetchSeq;
    try {
      const data = sub === "opencode"
        ? await fetchOpencodeUsage(apiKey)
        : await fetchZhipuQuota(apiKey);
      if (seq !== fetchSeq) return; // a newer request superseded this one
      quotaData = data;
      quotaFetchedAt = Date.now();
      errorText = "";
    } catch (e) {
      if (seq !== fetchSeq) return;
      const fresh = quotaFetchedAt > 0 && Date.now() - quotaFetchedAt <= STALE_KEEP_MS;
      if (!fresh) {
        quotaData = null;
        quotaFetchedAt = 0;
        errorText = `⚠ ${SUBSCRIPTION_DISPLAY[sub]}: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Keep last good data (marked stale by buildQuotaText) on transient errors.
    }
    updateFooter(ctx);
  }

  function throttledRefresh(thresholdMs: number, ctx: QuotaCtx): void {
    const now = Date.now();
    if (now - lastRefreshAt < thresholdMs) return;
    lastRefreshAt = now;
    void refreshQuota(ctx, ctx.model);
  }

  // ── Events (all receive fresh ctx) ──

  pi.on("model_select", async (event, ctx) => {
    lastRefreshAt = 0;
    activeModel = event.model;
    activeFooterCtx = ctx as QuotaCtx;
    requestFooterRender?.();
    void refreshQuota(ctx as QuotaCtx, event.model);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    activeThinkingLevel = event.level;
    updateFooter(ctx as QuotaCtx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    throttledRefresh(TURN_THROTTLE_MS, ctx as unknown as QuotaCtx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    throttledRefresh(TREE_THROTTLE_MS, ctx as unknown as QuotaCtx);
  });

  pi.on("session_start", async (_event, ctx) => {
    lastRefreshAt = 0;
    const quotaCtx = ctx as QuotaCtx;
    mountFooter(quotaCtx);
    void refreshQuota(quotaCtx, quotaCtx.model);
  });

  // Session is closing: clear cached state so a fresh session does not show
  // stale quota from a previous session.
  pi.on("session_shutdown", async () => {
    quotaData = null;
    quotaFetchedAt = 0;
    errorText = "";
    activeFooterCtx = null;
    activeModel = undefined;
    activeThinkingLevel = undefined;
  });
}
