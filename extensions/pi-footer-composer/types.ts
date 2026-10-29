export type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
export type Message = { role?: string; usage?: Usage; stopReason?: string };
export type Entry = { type?: string; message?: Message; usage?: Usage; customType?: string; data?: unknown };
export type Model = { id?: string; provider?: string; contextWindow?: number } | null;
export type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };
export type DataContext = {
  sessionManager: { getBranch(): Iterable<Entry> };
  getContextUsage?(): ContextUsage | undefined;
  model?: Model;
  thinkingLevel?: string;
};
export type Metric =
  | { version: 1; kind: "call"; ms: number; ttft: number | null; output: number | null; failed: boolean }
  | { version: 1; kind: "tool"; ms: number };
export type Snapshot = {
  rounds: number; steps: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  metrics: { calls: number; failed: number; llmMs: number; tools: number; toolMs: number; ttftMs: number; ttftCount: number; rateTokens: number; rateMs: number };
  context: ContextUsage | null;
  model: string; provider: string; thinking: string;
  working: boolean;
  waitingMs: number | null;
  live?: { estimated: boolean; rate: number | null; elapsedMs: number };
};
export function emptySnapshot(): Snapshot {
  return { rounds: 0, steps: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    metrics: { calls: 0, failed: 0, llmMs: 0, tools: 0, toolMs: 0, ttftMs: 0, ttftCount: 0, rateTokens: 0, rateMs: 0 },
    context: null, model: "未选择模型", provider: "", thinking: "", working: false, waitingMs: null };
}
