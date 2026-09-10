import { basename } from "node:path";
import { cleanText } from "./wrapping.ts";

export type Model = { id?: string; provider?: string; reasoning?: boolean; contextWindow?: number } | null;
type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
type Entry = { type?: string; message?: { role?: string; usage?: Usage }; usage?: Usage };
export type DataContext = {
  sessionManager: { getEntries(): readonly Entry[]; getCwd(): string; getSessionName(): string | null };
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
};
export type Snapshot = {
  fields: Record<string, string>;
  statuses: { key: string; text: string }[];
  contextPercent?: number | null;
};
function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${count < 10_000_000 ? (count / 1_000_000).toFixed(1) : Math.round(count / 1_000_000)}M`;
}
function cwdText(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}
export function collectSnapshot(ctx: DataContext, model: Model, thinking: string | undefined, branch: string | null, statuses: ReadonlyMap<string, string>): Snapshot {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let hit: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    const message = entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role || "") ? entry.message : undefined;
    const usage = message?.usage || (["branch_summary", "compaction"].includes(entry.type || "") ? entry.usage : undefined);
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) total[key] += usage[key] || 0;
    total.cost += usage.cost?.total || 0;
    if (message?.role === "assistant") {
      const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
      hit = prompt ? (usage.cacheRead || 0) / prompt * 100 : undefined;
    }
  }
  const context = ctx.getContextUsage?.();
  const percent = context?.percent;
  const window = context?.contextWindow ?? model?.contextWindow ?? 0;
  const fields: Record<string, string> = {
    project: basename(ctx.sessionManager.getCwd()) || "/", cwd: cwdText(ctx.sessionManager.getCwd()),
    branch: branch || "", session: ctx.sessionManager.getSessionName() || "",
    model: model?.id || "未选择模型", provider: model?.provider || "", thinking: model?.reasoning ? thinking || "off" : "",
    context: `${typeof percent === "number" && Number.isFinite(percent) ? percent.toFixed(1) + "%" : "?"} / ${window > 0 ? tokens(window) : "?"}`,
    cacheHit: (total.cacheRead || total.cacheWrite) && hit !== undefined ? `◎${hit.toFixed(1)}%` : "",
    cost: total.cost ? `$${total.cost.toFixed(3)}` : "",
  };
  for (const [key, prefix] of [["input", "↑"], ["output", "↓"], ["cacheRead", "读"], ["cacheWrite", "写"]] as const) {
    fields[key] = total[key] ? `${prefix}${tokens(total[key])}` : "";
  }
  return {
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cleanText(value)])),
    contextPercent: percent,
    statuses: [...statuses].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, text]) => ({
      key,
      text: cleanText(text).split("\n").map(line => line.trim().replace(/^(?:[⚡🔌⚙◎]\uFE0F?\s*)+/u, "")).filter(Boolean).join("\n"),
    })).filter(status => status.text),
  };
}
