/**
 * 纯格式化：token 估算、数值渲染、状态文本。
 *
 * 不 import pi 任何东西，也不写终端颜色：状态文本以纯文本发布，
 * 配色由绘制底栏的一方决定。
 */
import {
  CONTENT_CHARS_PER_TOKEN,
  LOADING_FRAMES,
  MAX_STATUS_WIDTH,
  MEASURING_LABEL,
  WAITING_LABEL,
} from "./constants.ts";
import type {
  AssistantMessageLike,
  LiveState,
  Measurement,
  ThroughputConfig,
  ThroughputSample,
} from "./types.ts";
import { truncateToWidth } from "./ui.ts";

export interface TokenCount {
  tokens: number;
  estimated: boolean;
}

/** 累加正文 / 思考 / 工具参数的字符数（估算分母）。 */
export function contentChars(message: AssistantMessageLike | undefined): number {
  let chars = 0;
  for (const block of message?.content ?? []) {
    if (block.type === "text") chars += block.text?.length ?? 0;
    else if (block.type === "thinking") chars += block.thinking?.length ?? 0;
    else if (block.type === "toolCall" && block.arguments !== undefined) {
      try {
        chars += JSON.stringify(block.arguments)?.length ?? 0;
      } catch {
        /* 循环引用等异常值不参与估算 */
      }
    }
  }
  return chars;
}

/** 输出 token：provider usage 优先，缺失时按字符数估算。 */
export function tokenCount(message: AssistantMessageLike | undefined): TokenCount {
  const reported = message?.usage?.output;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return { tokens: Math.round(reported), estimated: false };
  }
  return { tokens: Math.ceil(contentChars(message) / CONTENT_CHARS_PER_TOKEN), estimated: true };
}

/** TPS：100 以下保留一位小数，100 及以上取整（底栏不抖动）。 */
export function formatTps(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "--";
  return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(1);
}

/** 延迟：1s 以下用毫秒，1s 及以上用两位小数的秒。 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** token 数：万以上用 k，避免长会话数字撑爆底栏。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  return tokens >= 10_000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
}

/** 样本在指定口径下的 TPS；分母缺失或为零时为 null。 */
export function sampleTps(sample: ThroughputSample, measurement: Measurement): number | null {
  const spanMs = measurement === "stream" ? sample.streamMs : sample.e2eMs;
  if (spanMs === null || !Number.isFinite(spanMs) || spanMs <= 0) return null;
  if (!Number.isFinite(sample.tokens) || sample.tokens <= 0) return null;
  return (sample.tokens / spanMs) * 1000;
}

/**
 * 流中 TPS。
 *
 * 未结束时窗口不足 minWindowMs 一律返回 null（量化噪声），
 * 结束后的终值不再受窗口限制。
 */
export function liveTps(
  live: LiveState,
  measurement: Measurement,
  now: number,
  minWindowMs: number,
): number | null {
  if (live.tokens <= 0 || live.firstDeltaAt === null || live.startedAt === null) return null;
  const end = live.endedAt ?? now;
  const spanMs = measurement === "stream" ? end - live.firstDeltaAt : end - live.startedAt;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return null;
  if (live.endedAt === null && spanMs < minWindowMs) return null;
  return (live.tokens / spanMs) * 1000;
}

/**
 * 状态文本各段的可用值。
 *
 * 只有真正测到的指标才进 `parts`；加载占位只在还没有任何指标、且
 * 仍处于进行中的阶段时返回。
 */
function statusParts(
  live: LiveState,
  config: ThroughputConfig,
  now: number,
): { parts: string[]; loadingLabel: string | null } {
  const pending = live.phase === "waiting" || live.phase === "streaming";
  const ttftMs =
    live.firstDeltaAt !== null && live.startedAt !== null ? live.firstDeltaAt - live.startedAt : null;
  const tps = liveTps(live, config.measurement, now, config.minWindowMs);
  const parts: string[] = [];
  if (config.display !== "ttft" && tps !== null) parts.push(`${formatTps(tps)} t/s`);
  if (config.display !== "tps" && ttftMs !== null) parts.push(`首 token ${formatLatency(ttftMs)}`);
  let loadingLabel: string | null = null;
  if (pending) {
    if (ttftMs === null) loadingLabel = WAITING_LABEL;
    else if (config.display !== "ttft") loadingLabel = MEASURING_LABEL;
  }
  return { parts, loadingLabel };
}

/** 状态格文本；无事可报时返回 null。 */
export function buildStatusText(
  live: LiveState,
  config: ThroughputConfig,
  now: number,
  frame: string = LOADING_FRAMES[0] ?? "",
): string | null {
  if (live.phase === "idle") return null;
  const { parts, loadingLabel } = statusParts(live, config, now);
  if (parts.length > 0) return truncateToWidth(parts.join(" · "), MAX_STATUS_WIDTH);
  return loadingLabel === null
    ? null
    : truncateToWidth(`${frame} ${loadingLabel}`, MAX_STATUS_WIDTH);
}

/** 当前渲染的文本是否就是加载占位（决定要不要跑动画计时器）。 */
export function isTicking(live: LiveState, config: ThroughputConfig, now: number): boolean {
  if (live.phase === "idle") return false;
  const { parts, loadingLabel } = statusParts(live, config, now);
  return parts.length === 0 && loadingLabel !== null;
}
