/**
 * 会话级累计器 —— 纯函数，与宿主会话统计（sessionStats projection）同口径。
 *
 * 四个常驻指标都从完整调用记录折叠而来，不随单次调用重置：
 *
 *   llmMs    Σ(请求发出 → 消息结束)                 "模型用时"
 *   toolMs   Σ 工具执行时长                         "工具调用用时"
 *   ttftMs   首 token 延迟之和 / 有首 token 的调用数  "首 token 平均"
 *   tps      Σtoken ÷ Σ(首 token → 结束)             "输出速度"
 *
 * 和「每次调用的数值」不是一回事：长短调用混在一起时，
 * 按调用次数平均会把长调用压成和短调用同权。
 */
import { SAMPLE_TYPE, TOOL_SAMPLE_TYPE } from "./constants.ts";
import type { BranchEntryLike, LiveState, Measurement, ThroughputSample, ToolSample } from "./types.ts";

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

/** 累加一次已结束的调用。 */
export function addCall(totals: SessionTotals, sample: ThroughputSample): SessionTotals {
  const tokens = positive(sample.tokens);
  const e2eMs = positive(sample.e2eMs);
  const streamMs = positive(sample.streamMs);
  const ttftMs = sample.ttftMs !== null && Number.isFinite(sample.ttftMs) && sample.ttftMs >= 0 ? sample.ttftMs : null;
  if (tokens === null && e2eMs === null) return totals;
  return {
    calls: totals.calls + 1,
    llmMs: totals.llmMs + (e2eMs ?? 0),
    toolMs: totals.toolMs,
    ttftMs: totals.ttftMs + (ttftMs ?? 0),
    ttftSteps: totals.ttftSteps + (ttftMs === null ? 0 : 1),
    streamTokens: totals.streamTokens + (tokens !== null && streamMs !== null ? tokens : 0),
    streamMs: totals.streamMs + (tokens !== null && streamMs !== null ? streamMs : 0),
    e2eTokens: totals.e2eTokens + (tokens !== null && e2eMs !== null ? tokens : 0),
    e2eMs: totals.e2eMs + (tokens !== null && e2eMs !== null ? e2eMs : 0),
  };
}

/** 累加一次工具执行时长；不可用的时长直接忽略。 */
export function addTool(totals: SessionTotals, durationMs: unknown): SessionTotals {
  const value = positive(durationMs);
  if (value === null) return totals;
  return { ...totals, toolMs: totals.toolMs + value };
}

/** 把在飞调用叠加到累计值上：模型用时随等待增长，速率窗口够了才计入 token。 */
export function overlayLive(
  totals: SessionTotals,
  live: LiveState,
  measurement: Measurement,
  now: number,
  minWindowMs: number,
): SessionTotals {
  if (live.startedAt === null || live.phase === "idle" || live.phase === "done") return totals;
  const end = live.endedAt ?? now;
  const inFlight = Math.max(0, end - live.startedAt);
  const next: SessionTotals = { ...totals, llmMs: totals.llmMs + inFlight };
  if (live.firstDeltaAt === null || live.tokens <= 0) return next;
  const decodeMs = Math.max(0, end - live.firstDeltaAt);
  if (decodeMs < minWindowMs) return next;
  return measurement === "stream"
    ? {
        ...next,
        streamTokens: next.streamTokens + live.tokens,
        streamMs: next.streamMs + decodeMs,
      }
    : {
        ...next,
        e2eTokens: next.e2eTokens + live.tokens,
        e2eMs: next.e2eMs + Math.max(1, inFlight),
      };
}

/** 累计值 → 展示指标（平均、Σ/Σ 速率）。 */
export function deriveMetrics(totals: SessionTotals, measurement: Measurement): SessionMetrics {
  const tokens = measurement === "stream" ? totals.streamTokens : totals.e2eTokens;
  const spanMs = measurement === "stream" ? totals.streamMs : totals.e2eMs;
  return {
    llmMs: totals.llmMs > 0 ? totals.llmMs : null,
    toolMs: totals.toolMs > 0 ? totals.toolMs : null,
    ttftMs: totals.ttftSteps > 0 ? totals.ttftMs / totals.ttftSteps : null,
    tps: spanMs > 0 && tokens > 0 ? (tokens / spanMs) * 1000 : null,
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
      const sample = entry.data as ThroughputSample | undefined;
      // 与 stats.parseSamples 共享的校验口径：字段齐全才计入。
      if (
        sample &&
        typeof sample.model === "string" &&
        typeof sample.provider === "string" &&
        typeof sample.tokens === "number" &&
        typeof sample.e2eMs === "number" &&
        sample.e2eMs >= 0
      )
        totals = addCall(totals, sample);
    } else if (entry.customType === TOOL_SAMPLE_TYPE && isToolSample(entry.data)) {
      totals = addTool(totals, entry.data.durationMs);
    }
  }
  return totals;
}

/** 当前调用的速率是否已有可用的分母（决定要不要显示它在飞贡献）。 */
export function liveRateReady(live: LiveState, measurement: Measurement, now: number, minWindowMs: number): boolean {
  if (live.tokens <= 0 || live.firstDeltaAt === null || live.startedAt === null) return false;
  const end = live.endedAt ?? now;
  const spanMs = measurement === "stream" ? end - live.firstDeltaAt : end - live.startedAt;
  return spanMs >= minWindowMs;
}
