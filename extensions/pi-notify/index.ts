/** Terminal-only notifications after Pi's complete run has settled. */
import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatBody, freshStats, outcomeFor, type RunStats } from "./format.ts";
import {
  notificationBytes,
  resolveTerminal,
  singleLine,
  type TerminalPlan,
} from "./terminal.ts";

export { formatBody, formatDuration } from "./format.ts";

export interface NotifyIO {
  env(): NodeJS.ProcessEnv;
  isTTY(): boolean;
  write(value: string): void;
  now(): number;
  id(): string;
}

const defaultIO: NotifyIO = {
  env: () => process.env,
  isTTY: () => process.stdout.isTTY === true,
  write: (value) => {
    process.stdout.write(value);
  },
  now: Date.now,
  id: randomUUID,
};

function assistantReason(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as { role?: string; stopReason?: string };
  return m.role === "assistant" && typeof m.stopReason === "string"
    ? m.stopReason
    : undefined;
}

export function registerNotify(
  pi: ExtensionAPI,
  io: NotifyIO = defaultIO,
): void {
  let stats: RunStats = freshStats(io.now());
  let active = false;
  let enabled = true;
  let lastReason: string | undefined;
  let lastResult = "尚无运行结果";
  let lastDelivery = "尚未发送";
  let warned = new Set<string>();

  function terminalOnly(ctx: ExtensionContext): boolean {
    // hasUI also includes RPC: mode and the actual output stream both matter.
    return ctx.mode === "tui" && ctx.hasUI === true && io.isTTY();
  }

  function diagnostics(ctx: ExtensionContext, plan: TerminalPlan): string {
    return [
      `通知 · ${enabled && plan.protocol !== "off" ? "已开启" : "已关闭"}`,
      `终端：${plan.terminal}  ·  转发：${plan.detectedTransport}`,
      `协议：${plan.protocol ?? "未识别"}  ·  发送路径：${plan.transport ?? "不可用"}`,
      `输出：${terminalOnly(ctx) ? "交互终端" : `${ctx.mode ?? "未知模式"}，不写入终端控制序列`}`,
      `最近运行：${lastResult}`,
      `最近发送：${lastDelivery}`,
      ...plan.notes,
    ].join("\n");
  }

  function summary(ctx: ExtensionContext, plan: TerminalPlan): string {
    const configured = enabled && plan.protocol !== "off";
    const readiness = !configured
      ? "已关闭"
      : plan.blocked
        ? "需要配置"
        : terminalOnly(ctx)
          ? "可以发送"
          : "当前模式不发送";
    return [
      `通知 / ${configured ? "已开启" : "已关闭"}`,
      `${singleLine(plan.terminal, 48)} · ${readiness}`,
      "",
      `最近运行  ${singleLine(lastResult, 64)}`,
      `最近发送  ${singleLine(lastDelivery, 64)}`,
    ].join("\n");
  }

  function send(ctx: ExtensionContext, body: string, explicit = false): void {
    if (!terminalOnly(ctx)) {
      if (explicit && ctx.hasUI)
        ctx.ui.notify(
          "通知仅在 Pi 交互终端中发送；当前输出已保持不变。",
          "info",
        );
      return;
    }
    const plan = resolveTerminal(io.env());
    if (!enabled || plan.protocol === "off") {
      if (explicit)
        ctx.ui.notify(
          "通知已关闭。用 /notify on 开启本会话；PI_NOTIFY_PROTOCOL=off 需在启动环境中修改。",
          "info",
        );
      return;
    }
    if (plan.blocked) {
      lastDelivery = "未发送：终端或转发路径需要配置";
      const detail = diagnostics(ctx, plan);
      const warningKey = JSON.stringify([
        plan.terminal,
        plan.detectedTransport,
        plan.protocol,
        plan.transport,
        plan.notes,
      ]);
      if (explicit || !warned.has(warningKey)) {
        ctx.ui.notify(
          `${detail}\n用 /notify status 查看诊断；可显式设置 PI_NOTIFY_PROTOCOL=bell 降为终端响铃。`,
          "warning",
        );
        warned.add(warningKey);
      }
      return;
    }
    try {
      for (const bytes of notificationBytes(plan, "Pi", body, io.id()))
        io.write(bytes);
      lastDelivery = `已写入 ${plan.protocol}，桌面是否展示由终端和系统决定`;
      if (explicit)
        ctx.ui.notify(
          `${lastDelivery}。请查看系统通知；此处无法确认送达。`,
          "info",
        );
    } catch {
      lastDelivery = "写入终端失败";
      if (explicit || !warned.has(lastDelivery)) {
        ctx.ui.notify("通知写入终端失败；可用 /notify status 查看诊断。", "warning");
        warned.add(lastDelivery);
      }
    }
  }

  pi.on("session_start", () => {
    active = false;
    enabled = true;
    lastReason = undefined;
    lastResult = "尚无运行结果";
    lastDelivery = "尚未发送";
    warned = new Set();
  });
  pi.on("session_shutdown", () => {
    active = false;
  });
  pi.on("agent_start", () => {
    // Retries and queued continuations emit agent_start again before settling.
    if (!active) stats = freshStats(io.now());
    active = true;
    lastReason = undefined;
  });
  pi.on("turn_end", (event) => {
    if (!active) return;
    stats.turns++;
    lastReason =
      assistantReason((event as { message?: unknown }).message) ?? lastReason;
  });
  pi.on("tool_execution_end", (event) => {
    if (!active) return;
    const e = event as { toolName?: string; isError?: boolean };
    if (typeof e.toolName !== "string") return;
    stats.toolCalls++;
    stats.uniqueTools.add(e.toolName);
    if (e.isError) stats.errors++;
  });
  pi.on("agent_end", (event) => {
    if (!active) return;
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const reason = assistantReason(messages[i]);
      if (reason !== undefined) {
        lastReason = reason;
        break;
      }
    }
    // Record only. This event also fires during retry and compaction.
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!active || ctx.hasPendingMessages() || !ctx.isIdle()) return;
    active = false;
    const outcome = outcomeFor(lastReason);
    const body = formatBody(
      stats,
      ctx.sessionManager?.getSessionName?.() ?? null,
      outcome,
      io.now(),
    );
    lastResult = `${body}${stats.errors > 0 ? `（过程中 ${stats.errors} 次工具错误）` : ""}`;
    // An abort can be a user cancellation or manual compaction. Neither is a
    // successful completion; keep it visible in diagnostics without a banner.
    if (outcome !== "cancelled") send(ctx, body);
  });

  pi.registerCommand("notify", {
    description: "查看通知状态、发送测试通知、进入终端诊断或切换本会话通知。",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value) {
        if (!ctx.hasUI) return;
        const plan = resolveTerminal(io.env());
        if (ctx.mode !== "tui") {
          ctx.ui.notify(summary(ctx, plan), "info");
          return;
        }
        const choice = await ctx.ui.select(
          summary(ctx, plan),
          [
            "发送测试通知",
            enabled ? "关闭本会话通知" : "开启本会话通知",
            "查看终端诊断",
            "返回",
          ],
        );
        if (choice === "发送测试通知")
          send(ctx, "测试通知 · Waiting for your input", true);
        if (choice === "关闭本会话通知" || choice === "开启本会话通知") {
          enabled = choice === "开启本会话通知";
          ctx.ui.notify(
            enabled ? "本会话通知已开启。" : "本会话通知已关闭。",
            "info",
          );
        }
        if (choice === "查看终端诊断")
          await ctx.ui.select(diagnostics(ctx, plan), ["返回"]);
        return;
      }
      if (value === "status" || value === "help") {
        if (ctx.hasUI)
          ctx.ui.notify(
            `${diagnostics(ctx, resolveTerminal(io.env()))}\n/notify test [内容] · /notify on · /notify off`,
            "info",
          );
      } else if (value === "on" || value === "off") {
        enabled = value === "on";
        if (ctx.hasUI)
          ctx.ui.notify(
            enabled ? "本会话通知已开启。" : "本会话通知已关闭。",
            "info",
          );
      } else {
        // Preserve /notify <message>; the explicit test spelling is discoverable.
        const message =
          value === "test"
            ? "Waiting for your input"
            : value.startsWith("test ")
              ? value.slice(5).trim()
              : value;
        send(ctx, `测试通知 · ${message}`, true);
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerNotify(pi);
}
