/**
 * pi-quota-status — AI subscription quota monitor
 *
 * Shows remaining usage for the current provider's subscription and keeps
 * it fresh. A PURE CONTRIBUTOR: it does not touch footer rendering — it
 * publishes its text via `ctx.ui.setStatus("quota", …)` and lets whatever
 * renders the footer (pi's built-in footer or a footer-rendering extension
 * the user installed) decide placement and style. ANSI colors in the
 * status text survive pi's status sanitization, so threshold coloring
 * still works.
 *
 * Pure event-driven (no setInterval → no stale-ctx crash).
 *
 * ## File map
 *
 *   - types.ts        — QuotaBar / QuotaData / QuotaAdapter types
 *   - constants.ts    — timeouts, ANSI color codes, status key
 *   - state.ts        — module-level mutable state (quota + refresh guards)
 *   - adapters.ts     — ENDPOINTS, fetchJsonBearer, ADAPTERS registry,
 *                       PROVIDER_TO_SUB reverse lookup
 *   - format.ts       — formatBar / buildQuotaText (status text rendering)
 *   - index.ts        — this file: extension entry, events, refresh logic
 *
 * ## Architecture
 *
 * Each provider is a self-contained entry in the `ADAPTERS` registry
 * (see adapters.ts): `{ display, providerNames, apiKeyEnvVar, endpoint, fetch }`.
 * Adding a new subscription = add one entry; nothing else changes.
 *
 * Adapter fetchers return `QuotaBar[]` (a discriminated union: `percentage`
 * / `balance` / `text`). `buildQuotaText()` renders the bars to one colored
 * line and this file publishes it as a status. Robustness notes:
 *  - Fetches are serialized by a request sequence guard: a stale in-flight
 *    response can never overwrite newer data (fast model switching).
 *  - On fetch failure, the last good data is kept for STALE_KEEP_MS so
 *    transient network errors don't blank the status.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ADAPTERS,
  adapterEnvVars,
  resolveAdapterApiKey,
  subscriptionForProvider,
} from "./adapters.ts";
import {
  STALE_KEEP_MS,
  TREE_THROTTLE_MS,
  TURN_THROTTLE_MS,
  WIDGET_KEY,
} from "./constants.ts";
import { buildQuotaText } from "./format.ts";
import { state } from "./state.ts";
import type { ModelLike } from "./types.ts";

/** The ctx slice this extension touches: status publishing + the model. */
type StatusCtx = {
  ui: { setStatus(k: string, t: string | undefined): void };
  model: ModelLike;
};

// ---------------------------------------------------------------------------
// Status publishing
// ---------------------------------------------------------------------------

/** Publish (or clear) the quota status line. null text → clear. */
function publishStatus(ctx: StatusCtx): void {
  ctx.ui.setStatus(WIDGET_KEY, buildQuotaText() ?? undefined);
}

// ---------------------------------------------------------------------------
// Quota refresh logic
// ---------------------------------------------------------------------------

async function refreshQuota(ctx: StatusCtx, model: ModelLike): Promise<void> {
  const provider = model?.provider;
  const sub = subscriptionForProvider(provider);
  if (!sub) {
    // Unknown/no provider: clear everything (no stale fallback wanted).
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = "";
    publishStatus(ctx);
    return;
  }
  const adapter = ADAPTERS[sub];
  const apiKey = resolveAdapterApiKey(adapter);
  if (!apiKey) {
    const names = adapterEnvVars(adapter).join(" or ");
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = `⚠ ${adapter.display} 无 Key (${names})`;
    publishStatus(ctx);
    return;
  }

  const seq = ++state.fetchSeq;
  try {
    const bars = await adapter.fetch(apiKey);
    if (seq !== state.fetchSeq) return; // a newer request superseded this one
    state.quotaData = { provider: adapter.display, bars };
    state.quotaFetchedAt = Date.now();
    state.errorText = "";
  } catch (e) {
    if (seq !== state.fetchSeq) return;
    // Keep last good data ONLY for the same provider on a transient
    // failure. If the user just switched providers, the cached data
    // belongs to the OLD provider — showing it would mislead (e.g.
    // deepseek selected but ⚡MiniMax rendered). Provider switch =
    // stale-keep disabled, error surfaced instead.
    const sameProvider = state.quotaData?.provider === adapter.display;
    const fresh =
      sameProvider &&
      state.quotaFetchedAt > 0 &&
      Date.now() - state.quotaFetchedAt <= STALE_KEEP_MS;
    if (!fresh) {
      state.quotaData = null;
      state.quotaFetchedAt = 0;
      state.errorText = `⚠ ${adapter.display} ${describeFetchError(e)}`;
    }
    // Same-provider transient errors keep the last good data (marked
    // stale by buildQuotaText once older than STALE_KEEP_MS).
  }
  publishStatus(ctx);
}

/**
 * Map a fetch failure to a short, user-readable cause. Raw transport
 * messages ("fetch failed", "signal timed out", "HTTP 502") are accurate
 * for logs but hostile in a status line that is otherwise
 * Chinese-annotated. Adapter-domain errors (响应中无用量数据 …) pass
 * through unchanged.
 */
export function describeFetchError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof Error && e.name === "TimeoutError") return "请求超时";
  if (/timeout|timed out|aborted/i.test(msg)) return "请求超时";
  if (/^HTTP 401$/.test(msg) || /^HTTP 403$/.test(msg))
    return `Key 无效或已过期 (${msg})`;
  if (/^HTTP 429$/.test(msg)) return `请求过于频繁 (${msg})`;
  if (/^HTTP 5\d\d$/.test(msg)) return `服务暂不可用 (${msg})`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(msg))
    return "网络不可达";
  return msg;
}

function throttledRefresh(thresholdMs: number, ctx: StatusCtx): void {
  const now = Date.now();
  if (now - state.lastRefreshAt < thresholdMs) return;
  state.lastRefreshAt = now;
  void refreshQuota(ctx, ctx.model);
}

// ---------------------------------------------------------------------------
// Extension entry — event wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.on("model_select", async (event, ctx) => {
    state.lastRefreshAt = 0;
    void refreshQuota(ctx, event.model);
  });

  pi.on("turn_end", async (_event, ctx) => {
    throttledRefresh(TURN_THROTTLE_MS, ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    throttledRefresh(TREE_THROTTLE_MS, ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    state.lastRefreshAt = 0;
    void refreshQuota(ctx, ctx.model);
  });

  // Session is closing: clear cached state AND the published status so a
  // fresh session does not show stale quota from a previous session.
  pi.on("session_shutdown", async (_event, ctx) => {
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = "";
    ctx.ui.setStatus(WIDGET_KEY, undefined);
  });
}
