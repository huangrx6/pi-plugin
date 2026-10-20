/**
 * 会话级累计器 —— 纯函数；请求、正文传输与工具时长分别累计。
 *
 * 四个常驻指标都从完整调用记录折叠而来，不随单次调用重置：
 *
 *   llmMs    Σ(请求发出 → 消息结束)                 "模型用时"
 *   toolMs   Σ(工具派发 → 结果落地)                 "工具调用用时"
 *   ttftMs   首 token 延迟之和 / 有首 token 的调用数  "首 token 平均"
 *   tps      Σ选定口径的 token ÷ Σ对应时长          "输出速度"
 *
 * 和「每次调用的数值」不是一回事：长短调用混在一起时，
 * 按调用次数平均会把长调用压成和短调用同权。
 *
 * 中断 / 报错的调用只计次数、不计任何墙钟时间；速率只认 provider 上报的 token，
 * 字符估算只随样本保留，不进入 Σ/Σ。
 */
import { SAMPLE_TYPE, TOOL_SAMPLE_TYPE } from "./constants.ts";
import { parseSamples } from "./samples.ts";
import type { BranchEntryLike, Measurement, ThroughputSample, ToolSample } from "./types.ts";

export interface SessionTotals {
  /** 已结束并计入统计的调用数。 */
  calls: number;
  /** 模型用时：Σ(请求发出 → 消息结束)。 */
  llmMs: number;
  /** 工具调用用时：Σ 工具执行时长。 */
  toolMs: number;
  /** 首 token 延迟之和，与 ttftSteps 相除得到平均。 */
  ttftMs: number;
  ttftSteps: number;
  /** stream 口径的分子与分母：只有同时具备首 token 与 token 的调用才计入。 */
  streamTokens: number;
  streamMs: number;
  /** e2e 口径的分子与分母。 */
  e2eTokens: number;
  e2eMs: number;
}

export const EMPTY_TOTALS: SessionTotals = {
  calls: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  streamTokens: 0,
  streamMs: 0,
  e2eTokens: 0,
  e2eMs: 0,
};

/** 展示用的四项指标；尚未有数据时为 null（渲染成 `--`）。 */
export interface SessionMetrics {
  llmMs: number | null;
  toolMs: number | null;
  ttftMs: number | null;
  tps: number | null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function tokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 累加一次已结束的调用。 */
export function addCall(totals: SessionTotals, sample: ThroughputSample): SessionTotals {
  const tokens = tokenValue(sample.tokens);
  const e2eMs = positive(sample.e2eMs);
  const streamMs = positive(sample.streamMs);
  const streamTokens = tokenValue(sample.streamTokens);
  const ttftMs = sample.ttftMs !== null && Number.isFinite(sample.ttftMs) && sample.ttftMs >= 0 ? sample.ttftMs : null;
  if (!Number.isFinite(sample.e2eMs) || sample.e2eMs < 0 || !Number.isFinite(sample.tokens) || sample.tokens < 0) return totals;
  const calls = totals.calls + 1;
  // 中断 / 报错没有组装出完整消息：只计次数，不计时间与半截输出。
  if (sample.aborted) return { ...totals, calls };
  // 速率只认 provider 上报的 token；正文窗口使用已扣除推理的 token。
  const counted = sample.estimated === false && tokens !== null;
  const stream = counted && streamTokens !== null && streamMs !== null ? { tokens: streamTokens, ms: streamMs } : null;
  const e2e = counted && e2eMs !== null ? { tokens, ms: e2eMs } : null;
  return {
    calls,
    llmMs: totals.llmMs + (e2eMs ?? 0),
    toolMs: totals.toolMs,
    ttftMs: totals.ttftMs + (ttftMs ?? 0),
    ttftSteps: totals.ttftSteps + (ttftMs === null ? 0 : 1),
    streamTokens: totals.streamTokens + (stream?.tokens ?? 0),
    streamMs: totals.streamMs + (stream?.ms ?? 0),
    e2eTokens: totals.e2eTokens + (e2e?.tokens ?? 0),
    e2eMs: totals.e2eMs + (e2e?.ms ?? 0),
  };
}

/** 累加一次工具执行时长；不可用的时长直接忽略。 */
export function addTool(totals: SessionTotals, durationMs: unknown): SessionTotals {
  const value = positive(durationMs);
  if (value === null) return totals;
  return { ...totals, toolMs: totals.toolMs + value };
}

/** 累计值 → 展示指标（平均、Σ/Σ 速率）。 */
export function deriveMetrics(totals: SessionTotals, measurement: Measurement): SessionMetrics {
  const tokens = measurement === "stream" ? totals.streamTokens : totals.e2eTokens;
  const spanMs = measurement === "stream" ? totals.streamMs : totals.e2eMs;
  return {
    llmMs: totals.llmMs > 0 ? totals.llmMs : null,
    toolMs: totals.toolMs > 0 ? totals.toolMs : null,
    ttftMs: totals.ttftSteps > 0 ? totals.ttftMs / totals.ttftSteps : null,
    tps: spanMs > 0 ? (tokens / spanMs) * 1000 : null,
  };
}

function isToolSample(value: unknown): value is ToolSample {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0;
}

/** 从会话分支还原累计值：会话恢复、切换分支后统计不丢。 */
export function totalsFromEntries(entries: Iterable<unknown>): SessionTotals {
  let totals = EMPTY_TOTALS;
  for (const raw of entries) {
    const entry = raw as BranchEntryLike | null | undefined;
    if (entry?.type !== "custom") continue;
    if (entry.customType === SAMPLE_TYPE) {
      for (const sample of parseSamples([entry])) totals = addCall(totals, sample);
    } else if (entry.customType === TOOL_SAMPLE_TYPE && isToolSample(entry.data)) {
      totals = addTool(totals, entry.data.durationMs);
    }
  }
  return totals;
}
