/** 会话样本校验与读取；历史数据与内存统计使用同一口径。 */
import { SAMPLE_TYPE } from "./constants.ts";
import type { BranchEntryLike, ThroughputSample } from "./types.ts";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function duration(value: unknown): value is number | null {
  return value === null || (finite(value) && value >= 0);
}

export function isSample(value: unknown): value is ThroughputSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Record<string, unknown>;
  return typeof sample.model === "string" && typeof sample.provider === "string" &&
    finite(sample.tokens) && sample.tokens >= 0 && finite(sample.e2eMs) && sample.e2eMs >= 0 &&
    duration(sample.ttftMs) && duration(sample.streamMs) && finite(sample.at) &&
    (sample.streamTokens === undefined || sample.streamTokens === null ||
      (finite(sample.streamTokens) && sample.streamTokens >= 0 && sample.streamTokens <= sample.tokens));
}

export function parseSamples(entries: Iterable<unknown>): ThroughputSample[] {
  const samples: ThroughputSample[] = [];
  for (const raw of entries) {
    const entry = raw as BranchEntryLike | null | undefined;
    if (entry?.type !== "custom" || entry.customType !== SAMPLE_TYPE || !isSample(entry.data)) continue;
    samples.push({ ...entry.data, estimated: entry.data.estimated === true, aborted: entry.data.aborted === true });
  }
  return samples;
}
