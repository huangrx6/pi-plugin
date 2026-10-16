/**
 * 在 Pi 状态区发布实时输出速率与首 token 延迟，并把每次模型调用的
 * 样本写入会话（不进入 LLM context）。
 *
 * 发布约定：只写一个纯文本状态（key = pi-throughput）。任何按 key 读取
 * Pi 状态集合的底栏渲染器都可以显示它，本扩展不关心具体由谁绘制。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PACKAGE_NAME, SAMPLE_TYPE, STATUS_KEY, WAIT_TICK_MS } from "./constants.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { buildStatusText, isTicking } from "./format.ts";
import { formatSummary, parseSamples, summarize } from "./stats.ts";
import { createTracker } from "./tracker.ts";
import type {
  AssistantMessageEventLike,
  AssistantMessageLike,
  DisplayMode,
  Measurement,
  ThroughputConfig,
} from "./types.ts";

interface StatusCtx {
  model?: { id?: string; provider?: string } | null;
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  sessionManager?: { getBranch?(): Iterable<unknown> };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, level?: string): void;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

const DISPLAY_LABEL: Record<DisplayMode, string> = {
  full: "速率 + 首 token",
  tps: "仅速率",
  ttft: "仅首 token",
};

const MEASUREMENT_LABEL: Record<Measurement, string> = {
  stream: "流式（首 token 后）",
  e2e: "端到端（含等待）",
};

function onOff(value: boolean): string {
  return value ? "开" : "关";
}

export default function (pi: ExtensionAPI): void {
  let config: ThroughputConfig = loadConfig();
  const tracker = createTracker();
  let lastPaintAt = Number.NEGATIVE_INFINITY;
  let animation: ReturnType<typeof setInterval> | undefined;
  let lastText: string | null = null;
  let currentCtx: StatusCtx | null = null;

  function stopTicker(): void {
    if (animation === undefined) return;
    clearInterval(animation);
    animation = undefined;
  }

  function startTicker(ctx: StatusCtx): void {
    if (animation !== undefined) return;
    animation = setInterval(() => {
      // 会话被替换后旧上下文不再拥有 UI：停表而不是往旧状态格写入。
      if (currentCtx !== ctx) {
        stopTicker();
        return;
      }
      publish(ctx, true);
    }, WAIT_TICK_MS);
    // 等待计时不为进程保活。
    animation.unref?.();
  }

  /**
   * 发布状态：等待首 token 期间跑等待计时（仅 TUI），其余阶段按
   * throttleMs 节流。
   */
  function publish(ctx: StatusCtx, force = false): void {
    currentCtx = ctx;
    const live = tracker.snapshot();
    try {
      if (ctx.hasUI === false) {
        stopTicker();
        return;
      }
      const now = performance.now();
      const ticking =
        config.enabled && (ctx.mode ?? "tui") === "tui" && isTicking(live, config, now);
      // 计时器在屏上时，第一批真实指标必须立刻换掉它，不受节流推迟。
      const wasTicking = animation !== undefined;
      if (ticking) startTicker(ctx);
      else stopTicker();
      if (!config.enabled) {
        lastText = null;
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      if (!force && !ticking && !wasTicking && now - lastPaintAt < config.throttleMs) return;
      lastPaintAt = now;
      const text = buildStatusText(live, config, now);
      // 同一轮里指标暂时不可算（例如速率窗口未满）时保留上一帧，不闪空。
      if (text === null && lastText !== null && live.phase !== "idle") return;
      lastText = text;
      ctx.ui.setStatus(STATUS_KEY, text ?? undefined);
    } catch {
      /* 被替换的上下文不再拥有 UI */
      stopTicker();
    }
  }

  function samplesOf(ctx: StatusCtx) {
    return parseSamples(ctx.sessionManager?.getBranch?.() ?? []);
  }

  function summaryOf(ctx: StatusCtx): string {
    return formatSummary(summarize(samplesOf(ctx), config.measurement));
  }

  function settingsLine(configValue: ThroughputConfig): string {
    return (
      `显示 ${onOff(configValue.enabled)} · ${DISPLAY_LABEL[configValue.display]} · ` +
      `口径 ${MEASUREMENT_LABEL[configValue.measurement]} · ` +
      `终值保留 ${onOff(configValue.retainFinal)} · 样本记录 ${onOff(configValue.history)}`
    );
  }

  function apply(ctx: StatusCtx, next: ThroughputConfig): void {
    config = next;
    saveConfig(config);
    publish(ctx, true);
  }

  async function panel(ctx: StatusCtx): Promise<void> {
    for (;;) {
      const options = [
        `状态显示：${onOff(config.enabled)}`,
        `显示指标：${DISPLAY_LABEL[config.display]}`,
        `TPS 口径：${MEASUREMENT_LABEL[config.measurement]}`,
        `终值保留：${onOff(config.retainFinal)}`,
        `样本记录：${onOff(config.history)}`,
        "会话统计",
        "重新读取配置",
        "关闭",
      ];
      const selected = await ctx.ui.select(`${summaryOf(ctx)}\n\n当前：${settingsLine(config)}`, options);
      if (!selected || selected === "关闭") return;
      if (selected === "会话统计") {
        await ctx.ui.select(summaryOf(ctx), ["返回"]);
      } else if (selected === "重新读取配置") {
        config = loadConfig();
        publish(ctx, true);
      } else if (selected.startsWith("状态显示")) {
        apply(ctx, { ...config, enabled: !config.enabled });
      } else if (selected.startsWith("显示指标")) {
        const order: DisplayMode[] = ["full", "tps", "ttft"];
        const next = order[(order.indexOf(config.display) + 1) % order.length] ?? "full";
        apply(ctx, { ...config, display: next });
      } else if (selected.startsWith("TPS 口径")) {
        apply(ctx, { ...config, measurement: config.measurement === "stream" ? "e2e" : "stream" });
      } else if (selected.startsWith("终值保留")) {
        apply(ctx, { ...config, retainFinal: !config.retainFinal });
      } else if (selected.startsWith("样本记录")) {
        apply(ctx, { ...config, history: !config.history });
      }
    }
  }

  pi.registerCommand("throughput", {
    description:
      "查看或调整实时输出速率与首 token 延迟；stats 会话统计；on/off；display；measurement；reload",
    handler: async (args, ctx) => {
      const statusCtx = ctx as StatusCtx;
      const action = args.trim().toLowerCase();
      const isTui = (statusCtx.mode ?? "tui") === "tui" && statusCtx.hasUI !== false;
      if (!action || action === "status") {
        if (!isTui) {
          statusCtx.ui.notify(`${summaryOf(statusCtx)}\n\n${settingsLine(config)}`, "info");
          return;
        }
        await panel(statusCtx);
        return;
      }
      if (action === "stats") {
        const text = summaryOf(statusCtx);
        if (isTui) await statusCtx.ui.select(text, ["返回"]);
        else statusCtx.ui.notify(text, "info");
        return;
      }
      if (action === "on" || action === "off") {
        apply(statusCtx, { ...config, enabled: action === "on" });
        return;
      }
      if (action === "reload") {
        config = loadConfig();
        publish(statusCtx, true);
        statusCtx.ui.notify(settingsLine(config), "info");
        return;
      }
      const [key, value] = action.split(/\s+/);
      if (key === "display" && (value === "full" || value === "tps" || value === "ttft")) {
        apply(statusCtx, { ...config, display: value });
        return;
      }
      if (key === "measurement" && (value === "stream" || value === "e2e")) {
        apply(statusCtx, { ...config, measurement: value });
        return;
      }
      if ((key === "retain" || key === "history") && (value === "on" || value === "off")) {
        const enabledValue = value === "on";
        apply(
          statusCtx,
          key === "retain" ? { ...config, retainFinal: enabledValue } : { ...config, history: enabledValue },
        );
        return;
      }
      statusCtx.ui.notify(
        `${PACKAGE_NAME}：/throughput 打开设置 · /throughput stats 会话统计 · ` +
          "/throughput on|off · /throughput display full|tps|ttft · " +
          "/throughput measurement stream|e2e · /throughput retain|history on|off · /throughput reload",
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig();
    tracker.reset();
    publish(ctx as StatusCtx, true);
  });

  // 请求锚点：必须早于 provider 建立流，否则 TTFT 会系统性偏小。
  pi.on("before_provider_request", (_event, ctx) => {
    const statusCtx = ctx as StatusCtx;
    tracker.start({ provider: statusCtx.model?.provider, model: statusCtx.model?.id });
    publish(statusCtx, true);
  });

  pi.on("message_update", (event, ctx) => {
    const streamEvent = (event as { assistantMessageEvent?: AssistantMessageEventLike } | undefined)
      ?.assistantMessageEvent;
    tracker.update(streamEvent);
    publish(ctx as StatusCtx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = (event as { message?: AssistantMessageLike } | undefined)?.message;
    if (message?.role !== "assistant") return;
    const sample = tracker.finish(message);
    if (sample && config.history) {
      try {
        pi.appendEntry(SAMPLE_TYPE, sample);
      } catch {
        /* 记录失败不影响显示 */
      }
    }
    publish(ctx as StatusCtx, true);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (config.retainFinal) {
      stopTicker();
      return;
    }
    tracker.reset();
    publish(ctx as StatusCtx, true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    tracker.reset();
    stopTicker();
    try {
      (ctx as StatusCtx).ui.setStatus(STATUS_KEY, undefined);
    } catch {
      /* 会话正在关闭，UI 可能已不可用 */
    }
  });
}
