/**
 * Custom footer renderer + its supporting helpers.
 *
 * `renderFooter` is called by pi on every footer repaint. It computes the
 * three lines (pwd / stats / status+quota) using session entries, then
 * delegates to `buildQuotaText` for the quota segment.
 *
 * The width helpers (grapheme-aware, ANSI-safe) live here too because
 * they're footer-specific (truncating long lines to fit terminal width).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { C } from "./constants.ts";
import { buildQuotaText } from "./format.ts";
import type { FooterData, FooterTheme, QuotaCtx, UsageLike } from "./types.ts";

// ── Width helpers (grapheme-aware, ANSI-safe) ──────────────────────────

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const ANSI_ONCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  const code = segment.codePointAt(0) ?? 0;
  // Emoji / pictographic — uses explicit Unicode ranges rather than
  // `\p{Extended_Pictographic}` because TypeScript's lib may not
  // declare that property name (varies by TS version / lib update),
  // causing "Unknown character category" errors. The code-point ranges
  // cover the common emoji blocks; precision is fine for terminal-width
  // estimation (footer rendering only).
  if (
    (code >= 0x1f000 && code <= 0x1ffff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2300 && code <= 0x23ff)
  )
    return 2;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;
}

export function visibleWidth(text: string): number {
  const clean = text.replace(ANSI_PATTERN, "").replace(/\t/g, "   ");
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean))
    width += graphemeWidth(segment);
  return width;
}

export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis = "...",
): string {
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

// ── Footer small formatters (used by renderFooter) ─────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export function addUsage(
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  },
  usage: UsageLike | undefined,
): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

// ── Main footer renderer ──────────────────────────────────────────────

export function renderFooter(
  ctx: QuotaCtx,
  model: ExtensionContext["model"] | null,
  thinkingLevel: ExtensionContext["thinkingLevel"] | null,
  footerData: FooterData,
  theme: FooterTheme,
  width: number,
): string[] {
  const entries = ctx.sessionManager.getEntries();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const usage = entry.message.usage as UsageLike;
      addUsage(totals, usage);
      const promptTokens =
        (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      latestCacheHitRate =
        promptTokens > 0
          ? ((usage.cacheRead ?? 0) / promptTokens) * 100
          : undefined;
    } else if (
      entry.type === "message" &&
      entry.message?.role === "toolResult"
    ) {
      addUsage(totals, entry.message.usage as UsageLike | undefined);
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      addUsage(totals, entry.usage as UsageLike);
    }
  }

  let pwd = formatCwd(ctx.sessionManager.getCwd());
  const branch = footerData.getGitBranch();
  if (branch) pwd += ` (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) pwd += ` • ${sessionName}`;
  const pwdLine = truncateToWidth(
    theme.fg("dim", pwd),
    width,
    theme.fg("dim", "..."),
  );

  const statsParts: string[] = [];
  if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (
    (totals.cacheRead || totals.cacheWrite) &&
    latestCacheHitRate !== undefined
  ) {
    statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost) statsParts.push(`$${totals.cost.toFixed(3)}`);

  const contextUsage = ctx.getContextUsage?.();
  const contextWindow =
    contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
  const contextPercent =
    contextUsage?.percent === null || contextUsage?.percent === undefined
      ? "?"
      : contextUsage.percent.toFixed(1);
  const contextDisplay =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)} (auto)`
      : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
  statsParts.push(contextDisplay);

  let statsLeft = statsParts.join(" ");
  if (visibleWidth(statsLeft) > width)
    statsLeft = truncateToWidth(statsLeft, width, "...");

  const modelName = model?.id || "no-model";
  let modelText = modelName;
  if (model?.reasoning) {
    const thinking = thinkingLevel || "off";
    modelText =
      thinking === "off"
        ? `${modelName} • thinking off`
        : `${modelName} • ${thinking}`;
  }
  if (footerData.getAvailableProviderCount() > 1 && model) {
    const withProvider = `(${model.provider}) ${modelText}`;
    if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width)
      modelText = withProvider;
  }

  const availableForModel = width - visibleWidth(statsLeft) - 2;
  if (availableForModel <= 0) {
    modelText = "";
  } else if (visibleWidth(modelText) > availableForModel) {
    modelText = truncateToWidth(modelText, availableForModel, "");
  }
  const statsPad = " ".repeat(
    Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(modelText)),
  );
  const statsLine = theme.fg("dim", statsLeft + statsPad + modelText);

  const quota = buildQuotaText();
  const statuses = Array.from(footerData.getExtensionStatuses().entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .filter(Boolean)
    .join(" ");
  if (!quota) {
    return statuses
      ? [
          pwdLine,
          statsLine,
          truncateToWidth(statuses, width, theme.fg("dim", "...")),
        ]
      : [pwdLine, statsLine];
  }

  const quotaWidth = visibleWidth(quota);
  if (quotaWidth >= width)
    return [pwdLine, statsLine, truncateToWidth(quota, width, "")];

  const statusWidth = Math.max(0, width - quotaWidth - (statuses ? 2 : 0));
  const statusLeft = statuses
    ? truncateToWidth(statuses, statusWidth, theme.fg("dim", "..."))
    : "";
  const quotaPad = " ".repeat(width - visibleWidth(statusLeft) - quotaWidth);
  return [pwdLine, statsLine, statusLeft + quotaPad + quota];
}
