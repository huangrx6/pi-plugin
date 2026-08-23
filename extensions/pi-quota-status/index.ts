/**
 * pi-quota-status — AI subscription quota monitor
 *
 * Shows remaining usage in the footer, below the model and right-aligned.
 * Auto-switches between supported subscriptions based on the current model.
 *
 * Pure event-driven (no setInterval → no stale-ctx crash).
 * Uses a custom footer so quota can share the status row below the model.
 *
 * ## File map
 *
 *   - types.ts        — all TypeScript types (no runtime code)
 *   - constants.ts    — timeouts, ANSI color codes, widget key
 *   - state.ts        — module-level mutable state (quota + footer lifecycle)
 *   - adapters.ts     — ENDPOINTS, fetchJsonBearer, ADAPTERS registry,
 *                       PROVIDER_TO_SUB reverse lookup
 *   - format.ts       — formatBar / buildQuotaText (quota bar rendering)
 *   - render.ts       — renderFooter + width helpers + footer formatters
 *   - index.ts        — this file: extension entry, events, refresh logic
 *
 * ## Architecture
 *
 * Each provider is a self-contained entry in the `ADAPTERS` registry
 * (see adapters.ts): `{ display, providerNames, apiKeyEnvVar, endpoint, fetch }`.
 * Adding a new subscription = add one entry; nothing else changes.
 *
 * `subscriptionForProvider()` builds a reverse lookup (provider name →
 * subscription key) from the registry at module load, so there is no
 * separate PROVIDER_SUBSCRIPTION map to keep in sync.
 *
 * Adapter fetchers return `QuotaBar[]` (a discriminated union: `percentage`
 * / `balance` / `text`). The framework attaches the adapter's display tag
 * and hands the bars to `formatBar()`, which dispatches by kind for
 * unified rendering — see `buildQuotaText` in format.ts.
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
import { renderFooter } from "./render.ts";
import { state } from "./state.ts";
import type { ModelLike, QuotaCtx } from "./types.ts";

// ---------------------------------------------------------------------------
// Footer mounting / re-rendering
// ---------------------------------------------------------------------------

function mountFooter(ctx: QuotaCtx): void {
  // Re-mount on every session_start: pi clears the custom footer on
  // session invalidate (without firing session_shutdown), so a mount-once
  // flag would leave the footer gone after a session switch. Re-setting is
  // safe — setExtensionFooter disposes the previous footer first.
  state.activeFooterCtx = ctx;
  state.activeModel = ctx.model;
  state.activeThinkingLevel = ctx.thinkingLevel;
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  ctx.ui.setFooter((tui, theme, footerData) => {
    state.requestFooterRender = () => tui.requestRender();
    const unsubscribe = footerData.onBranchChange(state.requestFooterRender);
    return {
      render: (width: number) =>
        renderFooter(
          state.activeFooterCtx ?? ctx,
          state.activeModel,
          state.activeThinkingLevel,
          footerData,
          theme,
          width,
        ),
      invalidate: () => {},
      dispose: () => {
        unsubscribe();
        state.requestFooterRender = null;
      },
    };
  });
}

function updateFooter(ctx: QuotaCtx): void {
  state.activeFooterCtx = ctx;
  state.requestFooterRender?.();
}

// ---------------------------------------------------------------------------
// Quota refresh logic
// ---------------------------------------------------------------------------

async function refreshQuota(ctx: QuotaCtx, model: ModelLike): Promise<void> {
  const provider = model?.provider;
  const sub = subscriptionForProvider(provider);
  if (!sub) {
    // Unknown/no provider: clear everything (no stale fallback wanted).
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = "";
    updateFooter(ctx);
    return;
  }
  const adapter = ADAPTERS[sub];
  const apiKey = resolveAdapterApiKey(adapter);
  if (!apiKey) {
    const names = adapterEnvVars(adapter).join(" or ");
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = `⚠ ${adapter.display} 无 Key (${names})`;
    updateFooter(ctx);
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
      state.errorText = `⚠ ${adapter.display}: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Same-provider transient errors keep the last good data (marked
    // stale by buildQuotaText once older than STALE_KEEP_MS).
  }
  updateFooter(ctx);
}

function throttledRefresh(thresholdMs: number, ctx: QuotaCtx): void {
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
    state.activeModel = event.model;
    state.activeFooterCtx = ctx as QuotaCtx;
    state.requestFooterRender?.();
    void refreshQuota(ctx as QuotaCtx, event.model);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    state.activeThinkingLevel = event.level;
    updateFooter(ctx as QuotaCtx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    // SAFETY: pi's ExtensionContext is structurally a subset of QuotaCtx
    // because QuotaCtx only adds an OPTIONAL getContextUsage() field.
    // The double cast is required because TS treats the event's `ctx`
    // as the bare ExtensionContext type.
    throttledRefresh(TURN_THROTTLE_MS, ctx as unknown as QuotaCtx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    // SAFETY: see turn_end above — QuotaCtx only widens ExtensionContext
    // with an optional method, so the runtime value is always valid.
    throttledRefresh(TREE_THROTTLE_MS, ctx as unknown as QuotaCtx);
  });

  pi.on("session_start", async (_event, ctx) => {
    state.lastRefreshAt = 0;
    const quotaCtx = ctx as QuotaCtx;
    mountFooter(quotaCtx);
    void refreshQuota(quotaCtx, quotaCtx.model);
  });

  // Session is closing: clear cached state so a fresh session does not show
  // stale quota from a previous session.
  pi.on("session_shutdown", async () => {
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = "";
    state.activeFooterCtx = null;
    state.activeModel = null;
    state.activeThinkingLevel = null;
  });
}
