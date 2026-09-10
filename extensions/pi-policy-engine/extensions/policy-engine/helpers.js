// Pure helpers shared by commands.js / lifecycle.js / index.js.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sanitizeTerminalText } from "./terminal.js";

/**
 * Locate the package root by walking up to find the `policies/manifest.json` +
 * `config/routing.json` pair. Falls back to `<startDir>/../..` when not found
 * (matches the package layout shipped in this repo).
 */
export function findPackageRoot(startDir) {
  let current = resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    if (
      existsSync(join(current, "policies", "manifest.json")) &&
      existsSync(join(current, "config", "routing.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, "..", "..");
}

/** Append the latest recognition token usage to the host status text. */
export function appendUsageBadge(state, text) {
  const decision = state?.lastDecision;
  const latest =
    decision && !decision.preflightBlocked
      ? decision.recognition?.usageTokens
      : null;
  // Fall back to the cached latest usage so the badge survives reloads
  // (warmed from history) and conversation-only turns.
  const usage = latest ?? state?.lastUsageTokens ?? null;
  if (!usage || !Number.isFinite(usage.input)) return text;
  const fmt = (n) =>
    Number.isFinite(n)
      ? n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n)
      : "?";
  return `${text} ↑${fmt(usage.input)} ↓${fmt(usage.output)}`;
}

const MODE_LABELS = {
  auto: "自动",
  strict: "谨慎",
  off: "关闭",
};

const RIGOR_LABELS = {
  quick: "轻量",
  standard: "标准",
  strict: "严格",
  off: "关闭",
};

const PHASE_LABELS = {
  planning: "规划中",
  awaiting_approval: "待批准",
  executing: "执行中",
};

const OUTCOME_LABELS = {
  approved: "已批准",
  awaiting_approval: "待批准",
  blocked: "已阻止",
  failed: "失败",
  interrupted: "已中断",
  missing_plan: "待补计划",
  unverified: "待验证",
  verified: "已验证",
};

/**
 * Format the extension's live state for people, rather than exposing internal
 * enum names such as `policy:standard/executing`.
 */
export function formatPolicyStatus(state, mode = "auto") {
  if (state?.outcome === "blocked") return "未加载 · 已阻止";

  const strategy = state?.lastDecision?.rigor
    ? (RIGOR_LABELS[state.lastDecision.rigor] ?? state.lastDecision.rigor)
    : (MODE_LABELS[mode] ?? mode);
  const outcome = OUTCOME_LABELS[state?.outcome];
  const phase = PHASE_LABELS[state?.phase];
  const detail =
    state?.outcome && !["idle", "in_progress"].includes(state.outcome)
      ? outcome
      : phase;
  return [strategy, detail].filter(Boolean).join(" · ");
}

export function cleanModel(model) {
  if (!model) return null;
  return {
    provider: model.provider ?? "unknown",
    id: model.id ?? model.name ?? "unknown",
  };
}

export function modelKey(model) {
  if (!model) return "unknown";
  return `${model.provider ?? "unknown"}/${model.id ?? model.name ?? "unknown"}`;
}

/**
 * Safe wrapper around ctx.ui.notify: silently no-op when running in a
 * non-interactive context that does not expose UI helpers (e.g. tests, RPC).
 */
export function notify(ctx, message, level = "info") {
  try {
    ctx?.ui?.notify?.(sanitizeTerminalText(message), level);
  } catch {
    /* ignore */
  }
}

export function setStatus(ctx, text) {
  try {
    ctx?.ui?.setStatus?.("pi-policy-engine", text);
  } catch {
    /* ignore */
  }
}

export function syncPolicyStatus(ctx, state, config = {}) {
  const text =
    config.showStatus === false
      ? undefined
      : appendUsageBadge(
          state,
          formatPolicyStatus(state, config.mode ?? "auto"),
        );
  setStatus(ctx, text);
}

/**
 * Tokenize a `/policy <subcmd> [args...]` payload. Returns lowercase action
 * and remaining tokens.
 */
export function parsePolicyCommand(args) {
  const parts = String(args ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return { action: (parts[0] ?? "status").toLowerCase(), rest: parts.slice(1) };
}
