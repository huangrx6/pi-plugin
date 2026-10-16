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
  const tps = samples
    .map((sample) => sampleTps(sample, measurement))
    .filter((value): value is number => value !== null);
  const ttft = samples
    .map((sample) => sample.ttftMs)
    .filter((value): value is number => value !== null && value >= 0);
  return {
    calls: samples.length,
    aborted: samples.filter((sample) => sample.aborted).length,
    tokens: samples.reduce((sum, sample) => sum + sample.tokens, 0),
    avgTps: average(tps),
    p50Tps: percentile(tps, 50),
    p95Tps: percentile(tps, 95),
    avgTtftMs: average(ttft),
    p50TtftMs: percentile(ttft, 50),
    p95TtftMs: percentile(ttft, 95),
  };
}

/** 按模型分组汇总；组间按调用次数降序，次数相同按模型名。 */
export function summarize(
  samples: readonly ThroughputSample[],
  measurement: Measurement,
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
  return { measurement, overall: bucket(samples, measurement), byModel };
}

function metricLine(bucketLike: MetricBucket): string {
  const tps = bucketLike.avgTps === null ? "--" : formatTps(bucketLike.avgTps);
  const ttft = bucketLike.avgTtftMs === null ? "--" : formatLatency(bucketLike.avgTtftMs);
  return `⚡ ${tps} t/s · ⏱ ${ttft}`;
}

function percentileSuffix(bucketLike: MetricBucket): string {
  if (bucketLike.p95Tps === null && bucketLike.p95TtftMs === null) return "";
  const tps = bucketLike.p95Tps === null ? "--" : formatTps(bucketLike.p95Tps);
  const ttft = bucketLike.p95TtftMs === null ? "--" : formatLatency(bucketLike.p95TtftMs);
  return `（p95 ⚡ ${tps} · ⏱ ${ttft}）`;
}

/** 人读汇总；样本为空时给出明确文案而不是空表。 */
export function formatSummary(summary: ThroughputSummary): string {
  const name = summary.measurement === "stream" ? "流式（首 token 后）" : "端到端（含首 token 等待）";
  if (summary.overall.calls === 0) {
    return `尚未记录调用样本。口径：${name}`;
  }
  const lines = [
    `调用 ${summary.overall.calls} 次 · 中断 ${summary.overall.aborted} 次 · ${summary.overall.tokens} token`,
    `平均 ${metricLine(summary.overall)}${percentileSuffix(summary.overall)}`,
    `口径：${name}`,
  ];
  for (const model of summary.byModel) {
    lines.push(
      `· ${model.model || "未知模型"}：${model.calls} 次 ${metricLine(model)}${percentileSuffix(model)}`,
    );
  }
  return lines.join("\n");
}
