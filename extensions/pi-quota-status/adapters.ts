/**
 * Provider adapter registry.
 *
 * Each entry is a self-contained `{ display, providerNames, apiKeyEnvVar,
 * endpoint, fetch }` tuple. Adding a new subscription = add one entry.
 *
 * `subscriptionForProvider()` builds a reverse lookup (provider name →
 * subscription key) from this registry at module load, so there is no
 * separate PROVIDER_SUBSCRIPTION map to keep in sync.
 *
 * `as const satisfies Record<string, QuotaAdapter>` double-protects:
 * literal inference keeps narrow types (`display` is a string literal),
 * satisfies enforces shape (missing fields → type-check failure).
 */

import { FETCH_TIMEOUT_MS } from "./constants.ts";
import type { QuotaAdapter, QuotaBar } from "./types.ts";

// ── Endpoints (separate const so adapters reference them by name without
//    self-referential object literal) ─────────────────────────────────

export const ENDPOINTS = {
  opencode: "https://opencode.ai/zen/go/v1/usage",
  zhipu: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  minimax: "https://www.minimaxi.com/v1/token_plan/remains",
} as const;

// ── Shared JSON GET with Bearer auth + 15s timeout ─────────────────────

export async function fetchJsonBearer<T>(
  url: string,
  apiKey: string,
): Promise<T> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

/**
 * Build a percentage bar from Kimi-style `{limit, remaining, resetTime}`
 * fields. `limit` and `remaining` are strings (API quirk); we parse them
 * and compute used% = (limit - remaining) / limit * 100.
 *
 * Exported as a helper so any future percentage-window adapter with the
 * same shape can reuse it.
 */
export function percentBarFromLimitRemaining(
  detail: { limit: string; remaining: string; resetTime: string },
  label: string,
  now: number,
): QuotaBar | null {
  const limit = Number.parseFloat(detail.limit);
  const remaining = Number.parseFloat(detail.remaining);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) {
    return null;
  }
  const percent = Math.max(
    0,
    Math.min(100, ((limit - remaining) / limit) * 100),
  );
  const resetsInMs = new Date(detail.resetTime).getTime() - now;
  return {
    kind: "percentage",
    label,
    percent,
    resetsInMs: Number.isFinite(resetsInMs) ? resetsInMs : undefined,
  };
}

// ── Adapter registry ───────────────────────────────────────────────────

export const ADAPTERS = {
  opencode: {
    display: "⚡OC",
    providerNames: ["opencode-go"],
    apiKeyEnvVar: "OPENCODE_API_KEY",
    endpoint: ENDPOINTS.opencode,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        usage: {
          rolling: { percent: number; resetsAt: string };
          weekly: { percent: number; resetsAt: string };
          monthly: { percent: number; resetsAt: string };
        };
      }>(ENDPOINTS.opencode, apiKey);
      const now = Date.now();
      const win = (
        label: string,
        w: { percent: number; resetsAt: string },
      ): QuotaBar => ({
        kind: "percentage",
        label,
        percent: w.percent,
        resetsInMs: new Date(w.resetsAt).getTime() - now,
      });
      return [
        win("5h:", json.usage.rolling),
        win("周:", json.usage.weekly),
        win("月:", json.usage.monthly),
      ];
    },
  },

  zhipu: {
    display: "⚡GLM",
    providerNames: ["zai-coding-cn"],
    apiKeyEnvVar: "ZAI_API_KEY",
    endpoint: ENDPOINTS.zhipu,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        data: {
          limits: {
            type: string;
            unit?: number | null;
            percentage: number;
            nextResetTime: number;
          }[];
        };
      }>(ENDPOINTS.zhipu, apiKey);
      const now = Date.now();
      const limits = json.data?.limits ?? [];
      const find = (unit: number) =>
        limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === unit);
      const bars: QuotaBar[] = [];
      const fh = find(3);
      const wk = find(6);
      if (fh)
        bars.push({
          kind: "percentage",
          label: "5h:",
          percent: fh.percentage ?? 0,
          resetsInMs: fh.nextResetTime - now,
        });
      if (wk)
        bars.push({
          kind: "percentage",
          label: "周:",
          percent: wk.percentage ?? 0,
          resetsInMs: wk.nextResetTime - now,
        });
      return bars;
    },
  },

  minimax: {
    display: "⚡MiniMax",
    providerNames: ["minimax", "cc-switch-mini-max"],
    apiKeyEnvVar: "MINIMAX_API_KEY",
    endpoint: ENDPOINTS.minimax,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        model_remains?: Array<{
          model_name?: string;
          remains_time?: number;
          weekly_remains_time?: number;
          current_interval_remaining_percent?: number;
          current_weekly_remaining_percent?: number;
          end_time?: number;
          weekly_end_time?: number;
        }>;
        base_resp?: { status_code?: number; status_msg?: string };
      }>(ENDPOINTS.minimax, apiKey);
      // MiniMax returns HTTP 200 even for bad creds; base_resp is the
      // real success signal.
      if (json.base_resp?.status_code !== 0) {
        throw new Error(
          json.base_resp?.status_msg ||
            `API error (code ${json.base_resp?.status_code ?? "?"})`,
        );
      }
      const buckets = json.model_remains ?? [];
      // Prefer the shared "general" chat bucket; fall back to the first
      // bucket so single-pool plans still render.
      const bucket =
        buckets.find((b) => b.model_name === "general") ?? buckets[0];
      if (!bucket) throw new Error("响应中无 model_remains 数据");
      const now = Date.now();
      // Reset is published either as wall-clock epoch or as relative ms;
      // use whichever is present; -1 → "reset" in formatDuration.
      const resetMs = (
        wall: number | undefined,
        remaining: number | undefined,
      ): number => {
        if (typeof wall === "number") return wall - now;
        if (typeof remaining === "number") return remaining;
        return -1;
      };
      const bars: QuotaBar[] = [];
      if (typeof bucket.current_interval_remaining_percent === "number") {
        // MiniMax reports REMAINING percent; invert so colorForPercent
        // (calibrated to "higher = worse") stays correct.
        bars.push({
          kind: "percentage",
          label: "5h:",
          percent: Math.max(0, 100 - bucket.current_interval_remaining_percent),
          resetsInMs: resetMs(bucket.end_time, bucket.remains_time),
        });
      }
      if (typeof bucket.current_weekly_remaining_percent === "number") {
        bars.push({
          kind: "percentage",
          label: "周:",
          percent: Math.max(0, 100 - bucket.current_weekly_remaining_percent),
          resetsInMs: resetMs(
            bucket.weekly_end_time,
            bucket.weekly_remains_time,
          ),
        });
      }
      if (bars.length === 0) throw new Error("响应中无用量数据");
      return bars;
    },
  },
} as const satisfies Record<string, QuotaAdapter>;

/** Subscription keys are the keys of ADAPTERS. */
export type Subscription = keyof typeof ADAPTERS;

/** Reverse map: pi provider name → subscription key. Built once at load. */
export const PROVIDER_TO_SUB: ReadonlyMap<string, Subscription> = (() => {
  const m = new Map<string, Subscription>();
  for (const sub of Object.keys(ADAPTERS) as Subscription[]) {
    for (const name of ADAPTERS[sub].providerNames) m.set(name, sub);
  }
  return m;
})();

export function subscriptionForProvider(
  provider: string | undefined,
): Subscription | null {
  if (!provider) return null;
  return PROVIDER_TO_SUB.get(provider) ?? null;
}
