import { createHash } from "node:crypto";
import { ADAPTERS, adapterEnvVars, adapterMatchesModel, resolveAdapterApiKey, subscriptionForProvider, type Subscription } from "./adapters.ts";
import { STALE_KEEP_MS } from "./constants.ts";
import { createState } from "./state.ts";
import type { ModelLike } from "./types.ts";
export function describeFetchError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError" || /timeout|timed out|aborted/i.test(msg)) return "请求超时";
  if (/^HTTP 401$/.test(msg)) return "Key 无效或已过期 (HTTP 401)";
  if (/^HTTP 403$/.test(msg)) return "Key 无权限或产品不匹配 (HTTP 403)";
  if (/^HTTP 429$/.test(msg)) return "请求过于频繁 (HTTP 429)";
  if (/^HTTP 5\d\d$/.test(msg)) return `服务暂不可用 (${msg})`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(msg)) return "网络不可达";
  if (/数据格式异常|百分比超出|套餐剩余超过|查询失败|响应中无|无法确定|余额币种未知/.test(msg) && !/[\x00-\x1f\x7f]/.test(msg)) return msg.slice(0, 120);
  return "查询失败，请稍后刷新";
}
export function createMonitor() {
  const state = createState();
  let controller: AbortController | undefined;
  let adapterId: Subscription | null = null;
  const identityFor = (model: ModelLike, id: Subscription | null) => {
    const adapter = id ? ADAPTERS[id] : undefined;
    const key = adapter ? resolveAdapterApiKey(adapter) : "";
    return JSON.stringify([model?.provider, model?.baseUrl, id, adapter?.endpoint, createHash("sha256").update(key ?? "").digest("hex")]);
  };
  const clear = () => {
    state.quotaData = null;
    state.quotaFetchedAt = 0;
    state.errorText = "";
    state.lastRefreshError = "";
    state.loading = false;
  };
  const invalidate = () => {
    ++state.fetchSeq;
    controller?.abort();
    controller = undefined;
    clear();
    state.identity = "";
    state.lastRefreshAt = 0;
    adapterId = null;
  };
  return {
    state,
    get adapter() { return adapterId ? ADAPTERS[adapterId] : undefined; },
    invalidate,
    matches(model: ModelLike) { return state.identity === identityFor(model, subscriptionForProvider(model?.provider)); },
    async refresh(model: ModelLike, publish: () => void, explicit?: Subscription) {
      const seq = ++state.fetchSeq;
      controller?.abort();
      controller = undefined;
      adapterId = explicit ?? subscriptionForProvider(model?.provider);
      const identity = identityFor(model, adapterId);
      if (identity !== state.identity) clear();
      state.identity = identity;
      state.lastRefreshAt = Date.now();
      if (!adapterId) { clear(); publish(); return; }
      const adapter = ADAPTERS[adapterId];
      if (!explicit && !adapterMatchesModel(adapter, model)) {
        clear(); state.errorText = `${adapter.display} 当前端点未适配，未查询其他地区账户`; publish(); return;
      }
      const key = resolveAdapterApiKey(adapter);
      if (!key) {
        clear(); state.errorText = `${adapter.display} 未配置 ${adapterEnvVars(adapter).join(" / ")}`; publish(); return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      state.loading = true;
      publish();
      const current = () => seq === state.fetchSeq && !signal.aborted;
      try {
        const bars = await adapter.fetch(key, signal);
        if (!current()) return;
        if (resolveAdapterApiKey(adapter) !== key) { invalidate(); state.errorText = "凭证已变化，请刷新额度"; publish(); return; }
        if (!bars.length) throw new Error("响应中无额度数据");
        state.quotaData = { provider: adapter.display, bars };
        state.quotaFetchedAt = Date.now();
        state.errorText = "";
        state.lastRefreshError = "";
      } catch (error) {
        if (!current()) return;
        if (resolveAdapterApiKey(adapter) !== key) { invalidate(); state.errorText = "凭证已变化，请刷新额度"; publish(); return; }
        const message = describeFetchError(error);
        const transient = /请求超时|网络不可达|服务暂不可用|请求过于频繁/.test(message);
        const keep = transient && state.quotaData && state.quotaFetchedAt > 0 && Date.now() - state.quotaFetchedAt <= STALE_KEEP_MS;
        if (keep) state.lastRefreshError = message;
        else { clear(); state.errorText = `${adapter.display} ${message}`; }
      }
      if (!current()) return;
      state.loading = false;
      publish();
    },
  };
}
