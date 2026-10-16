/** Explicit endpoints prevent credentials going to inferred hosts. */
import { FETCH_TIMEOUT_MS } from "./constants.ts";
import { array, money, number, object, percent, percentBarFromLimitRemaining, resetIn } from "./parse.ts";
import type { ModelLike, QuotaAdapter, QuotaBar } from "./types.ts";
export { percentBarFromLimitRemaining } from "./parse.ts";
export const ENDPOINTS = {
  opencode: "https://opencode.ai/zen/go/v1/usage",
  zhipu: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  minimax: "https://www.minimaxi.com/v1/token_plan/remains",
  deepseek: "https://api.deepseek.com/user/balance",
  kimi: "https://api.kimi.com/coding/v1/usages",
  moonshot: "https://api.moonshot.cn/v1/users/me/balance",
  siliconflow: "https://api.siliconflow.cn/v1/user/info",
  openrouter: "https://openrouter.ai/api/v1/key",
  openrouterAccount: "https://openrouter.ai/api/v1/credits",
} as const;
export async function fetchJsonBearer(url: string, apiKey: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return object(await response.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export const ADAPTERS = {
  opencode: {
    display: "⚡OC", title: "OpenCode Go", category: "套餐用量",
    providerNames: ["opencode-go"], apiKeyEnvVar: "OPENCODE_API_KEY",
    endpoint: ENDPOINTS.opencode, modelHosts: ["opencode.ai"], note: "Go 套餐已用比例；不适用于 Zen 按量计费。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.opencode, key, signal);
      const usage = object(json.usage, "套餐用量");
      const now = Date.now();
      return [["rolling", "5h:"], ["weekly", "周:"], ["monthly", "月:"]].map(([field, label]) => {
        const win = object(usage[field], field);
        return { kind: "percentage", label, percent: percent(win.percent), resetsInMs: resetIn(win.resetsAt, now) } as QuotaBar;
      });
    },
  },
  zhipu: {
    display: "⚡GLM", title: "GLM Coding Plan · 国内", category: "套餐用量",
    providerNames: ["zai-coding-cn"], apiKeyEnvVar: "ZAI_CODING_CN_API_KEY", apiKeyEnvVarAliases: ["ZAI_API_KEY"],
    endpoint: ENDPOINTS.zhipu, modelHosts: ["open.bigmodel.cn"], note: "仅国内 Coding Plan；已用比例，国际站未适配。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.zhipu, key, signal);
      if (json.success === false || (json.code !== undefined && ![0, 200, "0", "200"].includes(json.code as number | string))) throw new Error("套餐查询失败");
      const limits = array(object(json.data).limits, "套餐窗口").map(item => object(item));
      const bars: QuotaBar[] = [];
      for (const [unit, label] of [[3, "5h:"], [6, "周:"]] as const) {
        const win = limits.find(item => item.type === "TOKENS_LIMIT" && item.unit === unit);
        if (win) bars.push({ kind: "percentage", label, percent: percent(win.percentage), resetsInMs: resetIn(win.nextResetTime, Date.now()) });
      }
      if (!bars.length) throw new Error("响应中无已识别的套餐窗口");
      return bars;
    },
  },
  minimax: {
    display: "⚡MiniMax", title: "MiniMax Token Plan · 国内", category: "套餐用量",
    providerNames: ["minimax", "cc-switch-mini-max", "minimax-cn"], apiKeyEnvVar: "MINIMAX_CN_API_KEY", apiKeyEnvVarAliases: ["MINIMAX_API_KEY"],
    endpoint: ENDPOINTS.minimax, modelHosts: ["api.minimaxi.com", "www.minimaxi.com"], note: "需要国内 Token Plan 专用 Key；显示已用比例。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.minimax, key, signal);
      if (object(json.base_resp).status_code !== 0) throw new Error("Token Plan 查询失败，请确认专用 Key");
      const buckets = array(json.model_remains, "套餐").map(item => object(item));
      const bucket = buckets.find(item => item.model_name === "general") ?? (buckets.length === 1 ? buckets[0] : undefined);
      if (!bucket) throw new Error("无法确定共享套餐窗口");
      const bars: QuotaBar[] = [];
      for (const [field, label, wall, relative] of [
        ["current_interval_remaining_percent", "5h:", "end_time", "remains_time"],
        ["current_weekly_remaining_percent", "周:", "weekly_end_time", "weekly_remains_time"],
      ]) {
        if (!(field in bucket)) continue;
        const remaining = percent(bucket[field]);
        const relativeMs = number(bucket[relative], "重置时间");
        bars.push({ kind: "percentage", label, percent: remaining === null ? null : 100 - remaining, resetsInMs: resetIn(bucket[wall], Date.now()) ?? (relativeMs !== null && relativeMs >= 0 ? relativeMs : undefined) });
      }
      if (!bars.length) throw new Error("响应中无用量数据");
      return bars;
    },
  },
  kimi: {
    display: "⚡Kimi Code", title: "Kimi Code", category: "套餐用量",
    providerNames: ["kimi", "kimi-code", "kimi-coding"], apiKeyEnvVar: "KIMI_API_KEY",
    endpoint: ENDPOINTS.kimi, modelHosts: ["api.kimi.com"], note: "Kimi Code 专用 Key；总套餐窗口不推断为固定一周。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.kimi, key, signal);
      const bars: QuotaBar[] = [];
      for (const item of json.limits === undefined ? [] : array(json.limits, "套餐窗口")) {
        const limit = object(item);
        const win = object(limit.window);
        if (win.duration === 300 && ["TIME_UNIT_MINUTE", "MINUTE", "MINUTES"].includes(String(win.timeUnit).toUpperCase()) && limit.detail) bars.push(percentBarFromLimitRemaining(limit.detail, "5h:", Date.now()));
      }
      if (json.usage) bars.push(percentBarFromLimitRemaining(json.usage, "套餐:", Date.now()));
      if (!bars.length) throw new Error("响应中无已识别的套餐窗口");
      return bars;
    },
  },
  deepseek: {
    display: "⚡DeepSeek", title: "DeepSeek API", category: "账户余额",
    providerNames: ["deepseek", "deepseek-cn"], apiKeyEnvVar: "DEEPSEEK_API_KEY",
    endpoint: ENDPOINTS.deepseek, modelHosts: ["api.deepseek.com"], note: "按接口返回币种逐项显示余额；可调用状态与余额分别显示。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.deepseek, key, signal);
      if (typeof json.is_available !== "boolean") throw new Error("账户状态数据格式异常");
      const entries = array(json.balance_infos, "余额");
      if (!entries.length) throw new Error("响应中无余额数据");
      const bars = entries.map(item => {
        const entry = object(item);
        if (entry.currency !== "CNY" && entry.currency !== "USD") throw new Error("余额币种未知");
        return money("余额:", entry.total_balance, entry.currency === "CNY" ? "¥" : "$");
      });
      if (!json.is_available) bars.push({ kind: "text", label: "状态:", text: "不可调用" });
      return bars;
    },
  },
  moonshot: {
    display: "⚡Kimi API", title: "Kimi API · 国内", category: "账户余额",
    providerNames: ["moonshot", "moonshot-cn", "kimi-api"], apiKeyEnvVar: "MOONSHOT_API_KEY",
    endpoint: ENDPOINTS.moonshot, modelHosts: ["api.moonshot.cn"], note: "国内 API 可用余额（含现金与代金券）；与 Kimi Code 套餐分开。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.moonshot, key, signal);
      if (json.code !== 0 || json.status !== true) throw new Error("API 余额查询失败");
      return [money("可用:", object(json.data).available_balance, "¥")];
    },
  },
  siliconflow: {
    display: "⚡SiliconFlow", title: "SiliconFlow · 国内", category: "账户余额",
    providerNames: ["siliconflow", "siliconflow-cn"], apiKeyEnvVar: "SILICONFLOW_API_KEY",
    endpoint: ENDPOINTS.siliconflow, modelHosts: ["api.siliconflow.cn"], note: "国内账户 totalBalance；含赠送与充值余额，国际站未适配。",
    async fetch(key: string, signal?: AbortSignal) {
      const json = await fetchJsonBearer(ENDPOINTS.siliconflow, key, signal);
      if (json.code !== 20000 || json.status !== true) throw new Error("账户余额查询失败");
      return [money("余额:", object(json.data).totalBalance, "¥")];
    },
  },
  openrouter: {
    display: "⚡OR", title: "OpenRouter · 当前 Key", category: "密钥额度",
    providerNames: ["openrouter"], apiKeyEnvVar: "OPENROUTER_API_KEY",
    endpoint: ENDPOINTS.openrouter, modelHosts: ["openrouter.ai"], note: "Key 的剩余消费上限，不代表账户余额；无限额不代表账户无限余额。",
    async fetch(key: string, signal?: AbortSignal) {
      const data = object((await fetchJsonBearer(ENDPOINTS.openrouter, key, signal)).data);
      if (data.limit === null && data.limit_remaining === null) return [{ kind: "text", label: "Key:", text: "未设上限" }];
      return [money("Key剩余:", data.limit_remaining, "$")];
    },
  },
  openrouterAccount: {
    display: "⚡OR 账户", title: "OpenRouter · 管理 Key 所属账户", category: "账户余额",
    providerNames: [], apiKeyEnvVar: "OPENROUTER_MANAGEMENT_KEY",
    endpoint: ENDPOINTS.openrouterAccount, modelHosts: ["openrouter.ai"], note: "管理 Key 所属账户；无法自动确认与当前推理 Key 同属一账户。",
    async fetch(key: string, signal?: AbortSignal) {
      const data = object((await fetchJsonBearer(ENDPOINTS.openrouterAccount, key, signal)).data);
      const credits = number(data.total_credits, "累计充值");
      const usage = number(data.total_usage, "累计使用");
      return [money("账户剩余:", credits === null || usage === null ? null : credits - usage, "$")];
    },
  },
} satisfies Record<string, QuotaAdapter>;
export type Subscription = keyof typeof ADAPTERS;
export const PROVIDER_TO_SUB: ReadonlyMap<string, Subscription> = new Map(
  (Object.keys(ADAPTERS) as Subscription[]).flatMap(id => ADAPTERS[id].providerNames.map(name => [name, id] as const)),
);
export function subscriptionForProvider(provider: string | undefined): Subscription | null {
  return provider ? PROVIDER_TO_SUB.get(provider) ?? null : null;
}
export function adapterEnvVars(adapter: QuotaAdapter): readonly string[] {
  return [adapter.apiKeyEnvVar, ...(adapter.apiKeyEnvVarAliases ?? [])];
}
export function resolveAdapterApiKey(adapter: QuotaAdapter): string | undefined {
  return adapterEnvVars(adapter).map(name => process.env[name]?.trim()).find(Boolean);
}
export function adapterMatchesModel(adapter: QuotaAdapter, model: ModelLike): boolean {
  if (!model?.baseUrl) return true;
  try {
    const url = new URL(model.baseUrl);
    return url.protocol === "https:" && adapter.modelHosts.includes(url.hostname);
  } catch { return false; }
}
