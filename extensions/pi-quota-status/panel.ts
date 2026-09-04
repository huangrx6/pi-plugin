import { ADAPTERS, adapterEnvVars } from "./adapters.ts";
import { STALE_KEEP_MS } from "./constants.ts";
import { formatDuration } from "./format.ts";
import type { ExtensionState } from "./state.ts";
import type { ModelLike, QuotaAdapter, QuotaBar } from "./types.ts";
import { sanitizeTerminalText, truncateToWidth } from "./ui.ts";

function meter(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

function row(bar: QuotaBar, elapsed: number): string {
  const label = sanitizeTerminalText(bar.label).replace(/:$/, "");
  if (bar.kind === "percentage") {
    if (bar.percent === null || !Number.isFinite(bar.percent)) return `  ${label}  --%`;
    const pct = Math.round(bar.percent * 10) / 10;
    const reset = bar.resetsInMs === undefined ? "" : formatDuration(bar.resetsInMs - elapsed);
    return truncateToWidth(`  ${label}  ${meter(pct)}  已用 ${pct}%${reset ? ` · ${reset} 后重置` : ""}`, 72);
  }
  if (bar.kind === "balance") {
    const amount = bar.amount === null || !Number.isFinite(bar.amount) ? "--" : bar.amount.toFixed(2);
    return truncateToWidth(`  ${label}  ${sanitizeTerminalText(bar.currency)}${amount}`, 72);
  }
  return truncateToWidth(`  ${label}  ${sanitizeTerminalText(bar.text)}`, 72);
}

/** Daily view: current object first, diagnostics excluded. */
export function quotaSummary(
  state: ExtensionState,
  adapter: QuotaAdapter | undefined,
  model: ModelLike,
  now = Date.now(),
): string {
  if (!adapter) {
    return [
      "额度 / 当前服务未适配",
      `Provider  ${truncateToWidth(model?.provider ?? "未选择", 48)}`,
      "",
      "可在“数据来源与诊断”中查看支持范围。",
    ].join("\n");
  }
  const lines = [`额度 / ${sanitizeTerminalText(adapter.title)}`, adapter.category, ""];
  if (state.quotaData) {
    const elapsed = Math.max(0, now - state.quotaFetchedAt);
    lines.push(...state.quotaData.bars.map(bar => row(bar, elapsed)));
    lines.push("", `更新于 ${new Date(state.quotaFetchedAt).toLocaleTimeString()}${elapsed > STALE_KEEP_MS ? " · 已过期" : ""}`);
  } else if (!state.loading && !state.errorText) {
    lines.push("尚无数据");
  }
  if (state.loading) lines.push("正在查询…");
  if (state.errorText) lines.push(`! ${truncateToWidth(state.errorText, 68)}`);
  if (state.lastRefreshError) lines.push(`! 刷新失败：${truncateToWidth(state.lastRefreshError, 54)}；显示上次成功值。`);
  return lines.join("\n");
}

/** Secondary view: source, credentials, semantic limits, and support scope. */
export function quotaDiagnostics(
  adapter: QuotaAdapter | undefined,
  model: ModelLike,
): string {
  const lines = ["额度 / 数据来源与诊断", ""];
  if (adapter) {
    lines.push(
      `${sanitizeTerminalText(adapter.title)} · ${adapter.category}`,
      sanitizeTerminalText(adapter.note),
      "",
      `接口  ${sanitizeTerminalText(adapter.endpoint)}`,
      `凭证  ${adapterEnvVars(adapter).map(sanitizeTerminalText).join(" / ")}`,
    );
  } else {
    lines.push(
      `Provider  ${truncateToWidth(model?.provider ?? "未选择", 48)}`,
      "按服务与地区识别账户，不按模型名称猜测。",
      "",
      "已适配",
      ...Object.values(ADAPTERS)
        .filter(item => item.providerNames.length)
        .map(item => `  ${sanitizeTerminalText(item.title)} · ${item.category}`),
    );
  }
  lines.push("", "未知值显示 --；响应契约已测试，真实账号仍需对账。");
  return lines.join("\n");
}

/** Compatibility export for callers that used the previous detail formatter. */
export const quotaDetails = quotaSummary;
