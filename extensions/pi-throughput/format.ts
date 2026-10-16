/**
 * 纯格式化：token 估算、数值渲染、状态文本。
 *
 * 不 import pi 任何东西，也不写终端颜色：状态文本以纯文本发布，
 * 配色由绘制底栏的一方决定。
 */
import { CONTENT_CHARS_PER_TOKEN, MAX_STATUS_WIDTH } from "./constants.ts";
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

/**
 * 时长：60s 以内按秒（<10s 一位小数），超过后换成 分/时。
 *
 * 底栏宽度有限，长等待不能一直堆秒数（`65.00s`），
 * `1m5s` 才是一眼能读的量。
 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
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
 * 只有真正测到的指标才进 `parts`；`waitingFor` 只在请求在飞、
 * 首 token 未到、且没有任何指标可报时给出（用于实时等待计时）。
 */
function statusParts(
  live: LiveState,
  config: ThroughputConfig,
  now: number,
): { parts: string[]; waitingFor: number | null } {
  const inFlight = live.phase === "waiting" || live.phase === "streaming";
  const ttftMs =
    live.firstDeltaAt !== null && live.startedAt !== null ? live.firstDeltaAt - live.startedAt : null;
  const tps = liveTps(live, config.measurement, now, config.minWindowMs);
  const parts: string[] = [];
  if (config.display !== "ttft" && tps !== null) parts.push(`速率: ${formatTps(tps)} t/s`);
  if (config.display !== "tps" && ttftMs !== null) parts.push(`首字: ${formatLatency(ttftMs)}`);
  const waitingFor =
    parts.length === 0 && inFlight && ttftMs === null && live.startedAt !== null
      ? Math.max(0, (live.endedAt ?? now) - live.startedAt)
      : null;
  return { parts, waitingFor };
}

/** 空闲占位：本会话还没有样本时，状态格也必须有内容。 */
export function idleText(config: ThroughputConfig): string {
  const parts: string[] = [];
  if (config.display !== "ttft") parts.push("速率: --");
  if (config.display !== "tps") parts.push("首字: --");
  return parts.join(" ");
}

/** 状态格文本；无事可报时返回 null。 */
export function buildStatusText(
  live: LiveState,
  config: ThroughputConfig,
  now: number,
): string | null {
  if (live.phase === "idle") return truncateToWidth(idleText(config), MAX_STATUS_WIDTH);
  const { parts, waitingFor } = statusParts(live, config, now);
  if (parts.length > 0) return truncateToWidth(parts.join(" "), MAX_STATUS_WIDTH);
  return waitingFor === null
    ? null
    : truncateToWidth(`首字: 等待 ${formatLatency(waitingFor)}`, MAX_STATUS_WIDTH);
}

/** 当前文本是否是持续刷新的等待计时（决定要不要跑计时器）。 */
export function isTicking(live: LiveState, config: ThroughputConfig, now: number): boolean {
  if (live.phase === "idle") return false;
  return statusParts(live, config, now).waitingFor !== null;
}
