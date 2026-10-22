import { METRIC_TYPE, parseMetric } from "./metrics.ts";
import { emptySnapshot, type DataContext, type Entry, type Message, type Metric, type Snapshot } from "./types.ts";
import { cleanText } from "./wrapping.ts";
export type { DataContext, Model, Snapshot } from "./types.ts";
const positive = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function addMetric(snapshot: Snapshot, sample: Metric): void {
  const m = snapshot.metrics;
  if (sample.kind === "tool") { m.tools++; m.toolMs += sample.ms; return; }
  m.calls++;
  if (sample.failed) { m.failed++; return; }
  m.llmMs += sample.ms;
  if (sample.ttft !== null) { m.ttftMs += sample.ttft; m.ttftCount++; }
  // 从首个非空内容增量计到结束；短回复和突发窗口不参与速度，分子分母严格配对。
  const generationMs = sample.ttft === null ? null : sample.ms - sample.ttft;
  if (sample.output !== null && sample.output >= 100 && generationMs !== null && generationMs >= 100) {
    m.rateTokens += sample.output; m.rateMs += generationMs;
  }
}
export function addMessage(snapshot: Snapshot, message?: Message): void {
  if (message?.role === "user") snapshot.rounds++;
  if (message?.role === "assistant") snapshot.steps++;
  if (message && ["assistant", "toolResult"].includes(message.role ?? "")) addUsage(snapshot, message.usage);
}
function addUsage(snapshot: Snapshot, usage: Message["usage"]): void {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) snapshot.usage[key] += positive(usage[key]);
  snapshot.usage.cost += positive(usage.cost?.total);
}
export function snapshotFromEntries(entries: Iterable<Entry>): Snapshot {
  const snapshot = emptySnapshot();
  for (const entry of entries) {
    if (entry.type === "message") addMessage(snapshot, entry.message);
    else if (["compaction", "branch_summary", "usage"].includes(entry.type ?? "")) addUsage(snapshot, entry.usage);
    else if (entry.type === "custom" && entry.customType === METRIC_TYPE) {
      const sample = parseMetric(entry.data); if (sample) addMetric(snapshot, sample);
    }
  }
  return snapshot;
}
/** 在宿主事件边界更新；render 和等待 ticker 不遍历历史/投影。 */
export function refreshContext(snapshot: Snapshot, ctx: DataContext): void {
  snapshot.model = cleanText(ctx.model?.id ?? "未选择模型").replace(/\n/g, " ");
  snapshot.provider = cleanText(ctx.model?.provider ?? "").replace(/\n/g, " ");
  snapshot.thinking = cleanText(ctx.thinkingLevel ?? "").replace(/\n/g, " ");
  const value = ctx.getContextUsage?.();
  const capacity = positive(value?.contextWindow ?? ctx.model?.contextWindow);
  const tokens = value?.tokens;
  // 已知 tokens 时从同一分母计算百分比，避免舍入或异步字段互相矛盾。
  const known = typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0;
  snapshot.context = capacity > 0 ? { tokens: known ? tokens : null, contextWindow: capacity,
    percent: known ? tokens / capacity * 100 : null } : null;
}
export function usageTotal(s: Snapshot): number { const u = s.usage; return u.input + u.output + u.cacheRead + u.cacheWrite; }
export function cacheHit(s: Snapshot): number | null {
  const u = s.usage, input = u.input + u.cacheRead + u.cacheWrite;
  return input > 0 ? u.cacheRead / input * 100 : null;
}
export function outputRate(s: Snapshot): number | null { return s.metrics.rateMs > 0 ? s.metrics.rateTokens / s.metrics.rateMs * 1000 : null; }
