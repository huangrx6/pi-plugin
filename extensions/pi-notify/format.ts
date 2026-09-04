import { singleLine } from "./terminal.ts";

export type Outcome = "completed" | "failed" | "cancelled" | "stopped";
export interface RunStats {
  turns: number;
  toolCalls: number;
  errors: number;
  uniqueTools: Set<string>;
  startedAt: number;
}

export function freshStats(now: number): RunStats {
  return {
    turns: 0,
    toolCalls: 0,
    errors: 0,
    uniqueTools: new Set(),
    startedAt: now,
  };
}

export function outcomeFor(reason: string | undefined): Outcome {
  if (reason === "stop") return "completed";
  if (reason === "error") return "failed";
  if (reason === "aborted") return "cancelled";
  return "stopped";
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, "0")}m`;
}

export function formatBody(
  stats: RunStats,
  sessionName: string | null,
  outcome: Outcome = "stopped",
  now = Date.now(),
): string {
  const labels: Record<Outcome, string> = {
    completed: "✓ Pi · 已结束",
    failed: "✗ Pi · 运行失败",
    cancelled: "— Pi · 已中断",
    stopped: "— Pi · 已停止，请检查结果",
  };
  const parts = [labels[outcome]];
  if (stats.turns > 0)
    parts.push(`${stats.turns} ${stats.turns === 1 ? "turn" : "turns"}`);
  if (stats.toolCalls > 0)
    parts.push(
      `${stats.toolCalls} ${stats.toolCalls === 1 ? "tool" : "tools"} (${stats.uniqueTools.size} unique)`,
    );
  parts.push(formatDuration(now - stats.startedAt));
  if (sessionName?.trim()) parts.push(singleLine(sessionName));
  return singleLine(parts.join(" · "));
}
