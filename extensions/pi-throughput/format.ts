/**
 * 纯格式化：token 估算、数值渲染、状态文本。
 *
 * 不 import pi 任何东西，也不写终端颜色：状态文本以纯文本发布，
 * 配色由绘制底栏的一方决定。
 */
import { CJK_TOKENS_PER_CHAR, MAX_STATUS_WIDTH, OTHER_CHARS_PER_TOKEN } from "./constants.ts";
import { deriveMetrics, type SessionTotals } from "./session.ts";
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

export interface TokenCount {
  tokens: number;
  estimated: boolean;
}

/** 正文字符量：CJK 与其余字符分开累计，估算时分母不同。 */
export interface ContentSize {
  cjk: number;
  other: number;
}

const CJK_PATTERN =
  /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function addSize(size: ContentSize, text: string | undefined): void {
  if (!text) return;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) size.cjk += 1;
    else size.other += 1;
  }
}

/** 正文 / 思考 / 工具参数按字符类型分别计数（估算分母）。 */
export function contentSize(message: AssistantMessageLike | undefined): ContentSize {
  const size: ContentSize = { cjk: 0, other: 0 };
  for (const block of message?.content ?? []) {
    if (block.type === "text") addSize(size, block.text);
    else if (block.type === "thinking") addSize(size, block.thinking);
    else if (block.type === "toolCall" && block.arguments !== undefined) {
      try {
        addSize(size, JSON.stringify(block.arguments));
      } catch {
        /* 循环引用等异常值不参与估算 */
      }
    }
  }
  return size;
}

/** 正文字符总数（CJK + 其余），保留给只关心量级的调用方。 */
export function contentChars(message: AssistantMessageLike | undefined): number {
  const size = contentSize(message);
  return size.cjk + size.other;
}

/** 输出 token：provider usage 优先，缺失时按字符类型估算。 */
export function tokenCount(message: AssistantMessageLike | undefined): TokenCount {
  const reported = message?.usage?.output;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return { tokens: Math.round(reported), estimated: false };
  }
  const size = contentSize(message);
  return {
    tokens: Math.ceil(size.cjk * CJK_TOKENS_PER_CHAR + size.other / OTHER_CHARS_PER_TOKEN),
    estimated: true,
  };
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
 * `1m5s` 才是一眼能读的量。亚毫秒读数取整到 `1ms`：
 * `0ms` 看起来像没测到，而它只是刚发出请求。
 */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
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
 * 等待首 token 的时长（毫秒）：只在请求已发出、首 token 未到时给出。
 *
 * 模型用时与速率已经是会话级常驻值，这里的数字只回答“这一次还要等多久”，
 * 所以作为短后缀追加在四项之后，不占用任何常驻位。
 */
export function waitingMs(live: LiveState, now: number): number | null {
  if (live.phase !== "waiting" || live.startedAt === null || live.firstDeltaAt !== null) return null;
  return Math.max(0, (live.endedAt ?? now) - live.startedAt);
}

/**
 * 状态格文本：会话级四项常驻（llm / tools / ttft / rate），等待期追加 `wait`。
 *
 * 数值来自会话累计值（已完成调用）叠加在飞调用的贡献，
 * 不随单次调用重置；尚未有数据的位置用 `--` 占位，格子始终有内容。
 */
export function buildStatusText(
  totals: SessionTotals,
  live: LiveState,
  config: ThroughputConfig,
  now: number,
): string {
  const metrics = deriveMetrics(totals, config.measurement);
  const parts: string[] = [];
  if (config.display === "full") {
    parts.push(`llm: ${metrics.llmMs === null ? "--" : formatLatency(metrics.llmMs)}`);
    parts.push(`tools: ${metrics.toolMs === null ? "--" : formatLatency(metrics.toolMs)}`);
  }
  if (config.display !== "tps") {
    parts.push(`ttft: ${metrics.ttftMs === null ? "--" : formatLatency(metrics.ttftMs)}`);
  }
  if (config.display !== "ttft") {
    parts.push(`rate: ${metrics.tps === null ? "--" : `${formatTps(metrics.tps)} t/s`}`);
  }
  const waiting = waitingMs(live, now);
  if (waiting !== null) parts.push(`wait ${formatLatency(waiting)}`);
  return truncateToWidth(parts.join(" · "), MAX_STATUS_WIDTH);
}

/** 当前文本是否带等待计时（决定要不要跑重绘定时器）。 */
export function isTicking(live: LiveState, now: number): boolean {
  return waitingMs(live, now) !== null;
}
