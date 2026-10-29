import type { Message, Metric } from "./types.ts";
export const METRIC_TYPE = "pi-footer-composer-metric";
const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function parseMetric(value: unknown): Metric | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Metric;
  if (v.version !== 1 || !valid(v.ms)) return null;
  if (v.kind === "tool") return { version: 1, kind: "tool", ms: v.ms };
  if (v.kind !== "call" || typeof v.failed !== "boolean" || !(v.ttft === null || valid(v.ttft) && v.ttft <= v.ms) || !(v.output === null || valid(v.output))) return null;
  return { version: 1, kind: "call", ms: v.ms, ttft: v.ttft, output: v.output, failed: v.failed };
}
/** 请求到结算的端到端窗口；重复请求钩子（例如重试）不重置起点。 */
export function createMeter(now: () => number = () => performance.now()) {
  let started: number | null = null, first: number | null = null;
  const tools = new Map<string, number>(), endedTools = new Set<string>();
  return {
    start() { started ??= now(); },
    delta(event?: { type?: string; delta?: unknown }) {
      if (started === null || first !== null || !["text_delta", "thinking_delta", "toolcall_delta"].includes(event?.type ?? "")) return;
      if (typeof event?.delta === "string" && event.delta.length) first = now();
    },
    finish(message: Message): Metric | null {
      if (started === null) return null;
      const sample: Metric = { version: 1, kind: "call", ms: Math.max(0, now() - started),
        ttft: first === null ? null : Math.max(0, first - started),
        output: valid(message.usage?.output) ? message.usage.output : null,
        failed: message.stopReason === "error" || message.stopReason === "aborted" };
      started = first = null;
      return sample;
    },
    toolStart(id: string) { if (id && !tools.has(id)) { endedTools.delete(id); tools.set(id, now()); } },
    toolEnd(id: string, fallback?: number): Metric | null {
      if (id && endedTools.has(id)) return null;
      const start = tools.get(id); tools.delete(id);
      const ms = start === undefined ? fallback : Math.max(0, now() - start);
      if (!valid(ms)) return null;
      if (id) endedTools.add(id);
      return { version: 1, kind: "tool", ms };
    },
    current() { return started === null ? null : { elapsedMs: Math.max(0, now() - started), generationMs: first === null ? null : Math.max(0, now() - first) }; },
    waiting() { return started === null || first !== null ? null : Math.max(0, now() - started); },
    reset() { started = first = null; tools.clear(); endedTools.clear(); },
  };
}
