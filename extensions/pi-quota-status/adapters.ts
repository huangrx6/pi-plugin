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
  deepseek: "https://api.deepseek.com/user/balance",
  kimi: "https://api.kimi.com/coding/v1/usages",
  openrouter: "https://openrouter.ai/api/v1/key",
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
  // ── Percentage-window providers ──────────────────────────────────────

  opencode: {
    display: "⚡OC",
    providerNames: ["opencode", "opencode-go"],
    apiKeyEnvVar: "OPENCODE_API_KEY",
    endpoint: ENDPOINTS.opencode,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        usage: {
          rolling: { percent: number | null; resetsAt: string | null };
          weekly: { percent: number | null; resetsAt: string | null };
          monthly: { percent: number | null; resetsAt: string | null };
        };
      }>(ENDPOINTS.opencode, apiKey);
      const now = Date.now();
      const win = (
        label: string,
        w: { percent: number | null; resetsAt: string | null },
      ): QuotaBar => ({
        kind: "percentage",
        label,
        percent: w.percent,
        resetsInMs: w.resetsAt
          ? new Date(w.resetsAt).getTime() - now
          : undefined,
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
    // Primary: pi-coding-agent's official env var for zai-coding-cn.
    // Aliases: shorter name + zai (no -cn region) variant — users who
    // set any of these get a working key without changing their config.
    apiKeyEnvVar: "ZAI_CODING_CN_API_KEY",
    apiKeyEnvVarAliases: ["ZAI_API_KEY"],
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
          // null percentage (fresh window / not yet billed) renders as
          // a dim "--%" placeholder — NOT a misleading "0%".
          percent: fh.percentage ?? null,
          resetsInMs: fh.nextResetTime ? fh.nextResetTime - now : undefined,
        });
      if (wk)
        bars.push({
          kind: "percentage",
          label: "周:",
          percent: wk.percentage ?? null,
          resetsInMs: wk.nextResetTime ? wk.nextResetTime - now : undefined,
        });
      return bars;
    },
  },

  minimax: {
    display: "⚡MiniMax",
    // Common aliases: canonical lowercase, cc-switch's default name
    // (older versions), and `minimax-cn` (cc-switch newer versions
    // and hand-rolled provider setups). All resolve to the same sub.
    providerNames: ["minimax", "cc-switch-mini-max", "minimax-cn"],
    // Primary: pi-coding-agent's official env var for minimax-cn.
    // Aliases: `MINIMAX_API_KEY` for users on the non-regional variant.
    apiKeyEnvVar: "MINIMAX_CN_API_KEY",
    apiKeyEnvVarAliases: ["MINIMAX_API_KEY"],
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

  kimi: {
    display: "⚡Kimi",
    // Kimi Code (会员订阅) uses a separate API key from the regular
    // Moonshot Open Platform key — alias both provider names just in case.
    providerNames: ["kimi", "moonshot", "kimi-code"],
    apiKeyEnvVar: "KIMI_API_KEY",
    endpoint: ENDPOINTS.kimi,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        usage?: {
          limit: string;
          remaining: string;
          resetTime: string;
        };
        limits?: Array<{
          window?: { duration: number; timeUnit: string };
          detail?: { limit: string; remaining: string; resetTime: string };
        }>;
      }>(ENDPOINTS.kimi, apiKey);
      const bars: QuotaBar[] = [];
      const now = Date.now();
      // 5h rolling window: limits[] entry with 300-minute duration.
      const fiveHour = json.limits?.find((l) => l.window?.duration === 300);
      if (fiveHour?.detail) {
        const bar = percentBarFromLimitRemaining(fiveHour.detail, "5h:", now);
        if (bar) bars.push(bar);
      }
      // `usage` is the wider overall quota (typically weekly on Kimi
      // Code — reset is days away, not hours).
      if (json.usage) {
        const bar = percentBarFromLimitRemaining(json.usage, "周:", now);
        if (bar) bars.push(bar);
      }
      if (bars.length === 0) throw new Error("响应中无用量数据");
      return bars;
    },
  },

  // ── Balance / remaining-credit providers ─────────────────────────────

  deepseek: {
    display: "⚡DeepSeek",
    providerNames: ["deepseek", "deepseek-cn"],
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
    endpoint: ENDPOINTS.deepseek,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        is_available: boolean;
        // Official field name (api-docs.deepseek.com/api/get-user-balance)
        // is `balance_infos`, not `balance` — older drafts used `balance`.
        balance_infos: Array<{
          currency: string;
          total_balance: string;
          granted_balance?: string;
          topped_up_balance?: string;
        }>;
        // Defensive fallback for a legacy/alternate shape in case the
        // API drifts back to `balance` — costs one property access.
        balance?: Array<{
          currency: string;
          total_balance: string;
          granted_balance?: string;
          topped_up_balance?: string;
        }>;
      }>(ENDPOINTS.deepseek, apiKey);
      const entry = json.balance_infos?.[0] ?? json.balance?.[0];
      if (!entry) throw new Error("响应中无余额数据");
      const amount = Number.parseFloat(entry.total_balance);
      if (!Number.isFinite(amount)) throw new Error("余额数据格式异常");
      // DeepSeek's API returns ISO-style currency codes (CNY / USD).
      // Map to display symbols; pass through unchanged if unknown.
      const symbol =
        entry.currency === "CNY" ? "¥" : entry.currency === "USD" ? "$" : "";
      // If is_available is false, force amount to 0 so the bar still
      // renders (the "无 Key" / API-error branches above already cover
      // the case of no key at all).
      return [
        {
          kind: "balance",
          label: "余额:",
          amount: json.is_available ? amount : 0,
          currency: symbol,
        },
      ];
    },
  },

  openrouter: {
    display: "⚡OR",
    providerNames: ["openrouter"],
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    endpoint: ENDPOINTS.openrouter,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{
        data?: {
          limit_remaining?: number | string | null;
          label?: string | null;
          is_free_tier?: boolean;
        };
      }>(ENDPOINTS.openrouter, apiKey);
      const data = json.data;
      if (
        !data ||
        data.limit_remaining === undefined ||
        data.limit_remaining === null
      ) {
        throw new Error("响应中无限度数据");
      }
      const amount = Number.parseFloat(String(data.limit_remaining));
      if (!Number.isFinite(amount)) throw new Error("额度数据格式异常");
      // OpenRouter credits are USD-denominated; the API doesn't return a
      // currency field, so we hard-code "$".
      return [
        {
          kind: "balance",
          label: data.is_free_tier ? "免费额度:" : "额度:",
          amount,
          currency: "$",
        },
      ];
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

/** All env-var names an adapter accepts for its API key, in lookup order
 *  (primary first, then aliases). Casts through `QuotaAdapter` so
 *  callers don't need to handle the inferred literal-type missing the
 *  optional `apiKeyEnvVarAliases` field. */
export function adapterEnvVars(adapter: QuotaAdapter): readonly string[] {
  const a = adapter as QuotaAdapter;
  return [a.apiKeyEnvVar, ...(a.apiKeyEnvVarAliases ?? [])];
}

/**
 * Resolve the API key for an adapter by trying its primary env var
 * (matches pi-coding-agent's official convention) then its aliases
 * (backward-compat with users who set shorter / different names).
 *
 * Returns the first env var that's set and non-empty. Returns
 * undefined if none are configured — caller should surface a "no key"
 * error to the user.
 */
export function resolveAdapterApiKey(
  adapter: QuotaAdapter,
): string | undefined {
  for (const name of adapterEnvVars(adapter)) {
    const value = process.env[name];
    if (value && value.trim() !== "") return value;
  }
  return undefined;
}
