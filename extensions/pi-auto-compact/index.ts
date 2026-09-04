/** Threshold-triggered native compaction. Pi owns all conversation persistence. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type Config } from "./config.ts";
import { CompactionContinuation, type CompactionNotice } from "./continuation.ts";
import { sanitizeTerminalText, wrapTerminalText } from "./terminal.ts";

interface Usage { tokens: number; contextWindow: number; percent: number }
export function contextUsage(ctx: any): Usage | undefined {
  const usage = ctx.getContextUsage?.();
  if (typeof usage?.tokens !== "number" || !Number.isFinite(usage.tokens) || usage.tokens < 0 ||
      typeof usage.contextWindow !== "number" || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return;
  return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.tokens / usage.contextWindow * 100 };
}
const tokens = (n: number) => n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
function notify(ctx: any, text: string, level = "info"): void {
  try { ctx.ui.notify(sanitizeTerminalText(text), level); } catch { /* Optional presentation. */ }
}
export function formatStatus(usage: Usage | undefined, config: Config, state?: string): string {
  return `◎ Context ${usage ? `${usage.percent.toFixed(0)}%` : "未知"}${state ? ` · ${state}` : config.enabled ? "" : " · 暂停"}`;
}

export default function (pi: ExtensionAPI): void {
  let config: Config = { ...DEFAULT_CONFIG };
  let initialized = false;
  let configError: string | undefined;
  let basePrompt: string | undefined;
  let objective = "";
  let lastCompaction: CompactionNotice | undefined;
  let currentContext: any;
  let compacting = false;
  const publish = (ctx: any) => {
    try { ctx.ui.setStatus("context:auto-compact", formatStatus(contextUsage(ctx), config, configError ? "配置错误" : compacting ? "压缩中" : config.enabled && lastCompaction?.status === "failed" ? "压缩失败" : undefined)); } catch { /* Optional status. */ }
  };
  const continuation = new CompactionContinuation(
    (task, instructions) => pi.sendMessage({ customType: "auto-compact-resume", display: false,
      content: `Automatic compaction interrupted this active task. Continue the next unfinished step using the compaction summary and existing user constraints. Do not repeat completed operations or ask the user to say continue. Original objective: ${task}${instructions ? `\n\nThese execution instructions were active before compaction. Continue to respect the existing constraints for this same task:\n<active-execution-instructions>\n${instructions}\n</active-execution-instructions>` : ""}`,
    }, { triggerTurn: true, deliverAs: "followUp" }),
    notice => {
      compacting = false;
      lastCompaction = notice;
      pi.appendEntry("auto-compact-maintenance", notice);
      if (currentContext) { publish(currentContext); notify(currentContext, notice.text, notice.status === "failed" ? "warning" : "info"); }
    },
  );
  const invalidate = () => { continuation.invalidate(); compacting = false; };
  pi.registerEntryRenderer<CompactionNotice>("auto-compact-maintenance", (entry, options, theme) => {
    if (!entry.data) return;
    const notice = entry.data;
    return { render(width: number) {
      const lines = wrapTerminalText(notice.text, width).map(line => theme.fg(notice.status === "failed" ? "warning" : "accent", line));
      if (options.expanded && notice.tokensBefore !== undefined) lines.push(...wrapTerminalText(`压缩前 ${tokens(notice.tokensBefore)} tokens · 压缩后估算 ${notice.tokensAfter === undefined ? "未知" : tokens(notice.tokensAfter)}`, width).map(line => theme.fg("dim", line)));
      return lines;
    }, invalidate() {} };
  });

  function stats(ctx: any): string {
    const usage = contextUsage(ctx);
    return [
      `上下文 · 自动压缩${config.enabled ? "开启" : "暂停"}${compacting ? " · 压缩中" : ""}`,
      usage ? `总窗口占用 ${usage.percent.toFixed(1)}% · ${tokens(usage.tokens)} / ${tokens(usage.contextWindow)} tokens（Pi 估算）` : "总窗口占用未知 · 等待 Pi 提供用量",
      `压缩阈值 ${config.thresholdPercent}% · 本次会话设置`,
      configError ? `配置错误：${configError}；修正配置后重新加载。` : lastCompaction?.text ?? "本次会话尚未自动压缩",
    ].join("\n");
  }
  pi.registerCommand("context", {
    description: "查看上下文占用、暂停自动压缩或调整阈值。",
    handler: async (args, ctx) => {
      try {
        if (!initialized) { notify(ctx, "自动压缩尚未初始化，请重新加载扩展。", "warning"); return; }
        let [action = "stats", ...rest] = String(args ?? "").trim().split(/\s+/).filter(Boolean);
        let value = rest.join(" ");
        if (!String(args ?? "").trim() && ctx.hasUI && ctx.ui.select) {
          const choices = ["查看使用情况", config.enabled ? "暂停自动压缩" : "恢复自动压缩", "调整压缩阈值"];
          const picked = await ctx.ui.select(stats(ctx), choices);
          if (!picked) return;
          action = picked === choices[0] ? "stats" : picked === choices[1] ? config.enabled ? "pause" : "resume" : "threshold";
          if (action === "threshold" && ctx.ui.input) {
            const input = await ctx.ui.input("压缩阈值 · 总窗口百分比（大于 0，小于 100）", String(config.thresholdPercent));
            if (input === undefined) return;
            value = input;
          }
        }
        if (action === "stats") { notify(ctx, stats(ctx)); return; }
        if (configError) { notify(ctx, `配置错误：${configError}；修正配置后重新加载。`, "warning"); return; }
        if (action === "pause" || action === "resume") {
          if (!continuation.isPending) invalidate();
          config.enabled = action === "resume";
          notify(ctx, `本次会话自动压缩已${config.enabled ? "开启" : "暂停"}；重新加载后使用配置文件。`);
        } else if (action === "threshold") {
          const percent = Number(value);
          if (!value.trim() || !Number.isFinite(percent) || percent <= 0 || percent >= 100) { notify(ctx, "用法：/context threshold <百分比>，必须大于 0 且小于 100，以总窗口为分母。", "warning"); return; }
          if (!continuation.isPending) invalidate();
          config.thresholdPercent = percent;
          notify(ctx, `本次会话压缩阈值已设为总窗口的 ${percent}%；重新加载后使用配置文件。`);
        } else notify(ctx, "可用操作：/context stats · /context pause · /context resume · /context threshold <百分比>。", "warning");
        publish(ctx);
      } catch (error) { notify(ctx, `上下文操作未完成：${error instanceof Error ? error.message : String(error)}`, "warning"); }
    },
  });
  pi.on("session_start", (event, ctx) => {
    invalidate(); initialized = true; currentContext = ctx; objective = ""; lastCompaction = undefined; configError = undefined;
    basePrompt = event.reason === "reload" ? undefined : ctx.getSystemPrompt?.();
    try { config = loadConfig(ctx.cwd, ctx.isProjectTrusted()); }
    catch (error) { config = { ...DEFAULT_CONFIG, enabled: false }; configError = sanitizeTerminalText(error instanceof Error ? error.message : String(error)); notify(ctx, `自动压缩已暂停：${configError}`, "warning"); }
    publish(ctx);
  });
  pi.on("input", invalidate);
  pi.on("before_agent_start", (event, ctx) => { continuation.invalidate(false); compacting = false; objective = event.prompt; currentContext = ctx; });
  pi.on("context", (_event, ctx) => {
    currentContext = ctx;
    const usage = contextUsage(ctx);
    publish(ctx);
    if (!initialized || !usage) return;
    const overThreshold = usage.percent >= config.thresholdPercent;
    continuation.observePressure(overThreshold);
    if (config.enabled && overThreshold) {
      compacting = true;
      continuation.request(ctx, objective, basePrompt);
      compacting = continuation.isPending;
      publish(ctx);
    }
    // No messages are replaced or injected into this request.
  });
  pi.on("turn_end", (_event, ctx) => publish(ctx));
  pi.on("session_compact", (_event, ctx) => publish(ctx));
  pi.on("session_before_switch", invalidate);
  pi.on("session_before_fork", invalidate);
  pi.on("session_before_tree", invalidate);
  pi.on("session_tree", invalidate);
  pi.on("model_select", (_event, ctx) => { invalidate(); basePrompt = undefined; publish(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { invalidate(); initialized = false; currentContext = undefined; try { ctx.ui.setStatus("context:auto-compact", undefined); } catch { /* Optional status. */ } });
}
