/**
 * 会话样本聚合 —— 纯函数：校验、分位数、汇总文本。
 *
 * 样本来自会话 JSONL 里的 custom entry（不进入 LLM context），
 * 所以恢复会话后还能复盘历史调用。
 */
import { SAMPLE_TYPE } from "./constants.ts";
import { formatLatency, formatTps } from "./format.ts";
import type { BranchEntryLike, Measurement, ThroughputSample } from "./types.ts";
import { sampleTps } from "./format.ts";

export interface MetricBucket {
  calls: number;
  aborted: number;
  tokens: number;
  /** 会话口径输出速度：Σtoken ÷ Σ时长（与宿主会话统计同口径）。 */
  tps: number | null;
  /** 模型用时：Σ（请求发出 → 消息结束）。 */
  modelMs: number | null;
  avgTps: number | null;
  p50Tps: number | null;
  p95Tps: number | null;
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
}

export interface ModelSummary extends MetricBucket {
  provider: string;
  model: string;
}

export interface ThroughputSummary {
  measurement: Measurement;
  /** 工具调用用时（Σ 工具执行时长）；未传入或为零时渲染成 `--`。 */
  toolMs: number | null;
  overall: MetricBucket;
  byModel: ModelSummary[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableDuration(value: unknown): value is number | null {
  return value === null || (isFiniteNumber(value) && value >= 0);
}

/** 校验一条 entry.data 是否为本扩展的样本。 */
export function isSample(value: unknown): value is ThroughputSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return (
    typeof sample.model === "string" &&
    typeof sample.provider === "string" &&
    isFiniteNumber(sample.tokens) &&
    sample.tokens >= 0 &&
    isFiniteNumber(sample.e2eMs) &&
    sample.e2eMs >= 0 &&
    isNullableDuration(sample.ttftMs) &&
    isNullableDuration(sample.streamMs) &&
    isFiniteNumber(sample.at)
  );
}

/** 从会话分支里挑出本扩展的样本；坏数据静默丢弃。 */
export function parseSamples(entries: Iterable<unknown>): ThroughputSample[] {
  const samples: ThroughputSample[] = [];
  for (const raw of entries) {
    const entry = raw as BranchEntryLike | null | undefined;
    if (entry?.type !== "custom" || entry.customType !== SAMPLE_TYPE) continue;
    if (!isSample(entry.data)) continue;
    const sample = entry.data;
    samples.push({
      ...sample,
      provider: sample.provider,
      model: sample.model,
      estimated: sample.estimated === true,
      aborted: sample.aborted === true,
      ttftMs: sample.ttftMs === null ? null : Math.max(0, sample.ttftMs),
      streamMs: sample.streamMs === null ? null : Math.max(0, sample.streamMs),
    });
  }
  return samples;
}

/** 最近秩分位数；空数组返回 null。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bucket(samples: readonly ThroughputSample[], measurement: Measurement): MetricBucket {
  const rates: number[] = [];
  // 速率的会话口径是 Σtoken ÷ Σ时长：先把分子分母各自累起来，
  // 不是「每次调用的 TPS 取平均」（长调用和短调用的权重不同，两者能差 10% 以上）。
  let spanTokens = 0;
  let spanMs = 0;
  let modelMs = 0;
  const ttft: number[] = [];
  for (const sample of samples) {
    const rate = sampleTps(sample, measurement);
    const span = measurement === "stream" ? sample.streamMs : sample.e2eMs;
    if (rate !== null && span !== null && span > 0) {
      rates.push(rate);
      spanTokens += sample.tokens;
      spanMs += span;
    }
    if (isFiniteNumber(sample.e2eMs) && sample.e2eMs > 0) modelMs += sample.e2eMs;
    if (sample.ttftMs !== null && sample.ttftMs >= 0) ttft.push(sample.ttftMs);
  }
  return {
    calls: samples.length,
    aborted: samples.filter((sample) => sample.aborted).length,
    tokens: samples.reduce((sum, sample) => sum + sample.tokens, 0),
    tps: spanMs > 0 ? (spanTokens / spanMs) * 1000 : null,
    modelMs: modelMs > 0 ? modelMs : null,
    avgTps: average(rates),
    p50Tps: percentile(rates, 50),
    p95Tps: percentile(rates, 95),
    avgTtftMs: average(ttft),
    p50TtftMs: percentile(ttft, 50),
    p95TtftMs: percentile(ttft, 95),
  };
}

/** 按模型分组汇总；组间按调用次数降序，次数相同按模型名。 */
export function summarize(
  samples: readonly ThroughputSample[],
  measurement: Measurement,
  toolMs: number | null = null,
): ThroughputSummary {
  const groups = new Map<string, ThroughputSample[]>();
  for (const sample of samples) {
    const key = `${sample.provider}\u0000${sample.model}`;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  const byModel: ModelSummary[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    byModel.push({
      provider: first?.provider ?? "",
      model: first?.model ?? "",
      ...bucket(group, measurement),
    });
  }
  byModel.sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
  return { measurement, toolMs: toolMs !== null && toolMs > 0 ? toolMs : null, overall: bucket(samples, measurement), byModel };
}

function metricLine(bucketLike: MetricBucket): string {
  const tps = bucketLike.tps === null ? "--" : `${formatTps(bucketLike.tps)} t/s`;
  const ttft = bucketLike.avgTtftMs === null ? "--" : formatLatency(bucketLike.avgTtftMs);
  return `⚡ ${tps} · ⏱ ${ttft}`;
}

function percentileSuffix(bucketLike: MetricBucket): string {
  if (bucketLike.p50Tps === null && bucketLike.p95Tps === null) return "";
  const p50 = bucketLike.p50Tps === null ? "--" : formatTps(bucketLike.p50Tps);
  const p95 = bucketLike.p95Tps === null ? "--" : formatTps(bucketLike.p95Tps);
  return `（p50 ${p50} · p95 ${p95} t/s）`;
}

/** 人读汇总；样本为空时给出明确文案而不是空表。 */
export function formatSummary(summary: ThroughputSummary): string {
  const name = summary.measurement === "stream" ? "流式（首 token 后）" : "端到端（含首 token 等待）";
  if (summary.overall.calls === 0) {
    return `尚未记录调用样本。口径：${name}`;
  }
  const overall = summary.overall;
  const tps = overall.tps === null ? "--" : `${formatTps(overall.tps)} t/s`;
  const modelMs = overall.modelMs === null ? "--" : formatLatency(overall.modelMs);
  const toolMs = summary.toolMs === null ? "--" : formatLatency(summary.toolMs);
  const ttft = overall.avgTtftMs === null ? "--" : formatLatency(overall.avgTtftMs);
  const lines = [
    `调用 ${overall.calls} 次 · 中断 ${overall.aborted} 次 · ${overall.tokens} token`,
    `模型用时 ${modelMs} · 工具调用用时 ${toolMs}`,
    `首 token 平均 ${ttft} · 输出速度 ${tps}${percentileSuffix(overall)}`,
    `口径：${name}；输出速度 = Σtoken ÷ Σ时长`,
  ];
  for (const model of summary.byModel) {
    lines.push(
      `· ${model.model || "未知模型"}：${model.calls} 次 ${metricLine(model)}`,
    );
  }
  return lines.join("\n");
}
