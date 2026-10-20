/** Host events → one cached snapshot → one summary and one anchored popover. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFooter, type FooterData, type Tui } from "./component.ts";
import { createFooterConfigStore, defaultFooterConfig, type FooterConfigStore } from "./config.ts";
import { addMessage, addMetric, refreshContext, snapshotFromEntries } from "./data.ts";
import { createMeter, METRIC_TYPE } from "./metrics.ts";
import type { Theme } from "./render.ts";
import type { PanelId } from "./settings.ts";
import { cleanText } from "./wrapping.ts";
import { emptySnapshot, type DataContext, type Metric } from "./types.ts";
type Context = DataContext & {
  hasUI?: boolean; mode?: string;
  ui: {
    setFooter(factory: ((tui: Tui, theme: Theme, data: FooterData) => unknown) | undefined): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    notify(message: string, level?: string): void;
  };
};
export default function (pi: ExtensionAPI, options: { configStore?: FooterConfigStore; now?: () => number } = {}): void {
  const store = options.configStore ?? createFooterConfigStore(), meter = createMeter(options.now);
  let config = defaultFooterConfig(), snapshot = emptySnapshot(), activeCtx: Context | null = null;
  let component: ReturnType<typeof createFooter> | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let transient: Metric[] = [];
  const stop = () => { if (ticker !== undefined) clearInterval(ticker); ticker = undefined; };
  const paint = () => { snapshot.waitingMs = meter.waiting(); component?.refresh(); };
  const persist = (sample: Metric | null) => {
    if (!sample) return;
    addMetric(snapshot, sample);
    try { pi.appendEntry(METRIC_TYPE, sample); } catch { transient.push(sample); }
  };
  const rebuild = (ctx: Context) => {
    const working = snapshot.working;
    snapshot = snapshotFromEntries(ctx.sessionManager.getBranch());
    for (const sample of transient) addMetric(snapshot, sample);
    snapshot.working = working;
    refreshContext(snapshot, ctx); activeCtx = ctx;
  };
  const mount = (ctx: Context) => {
    component?.dispose(); component = null; activeCtx = ctx;
    if (ctx.hasUI === false || ctx.mode && ctx.mode !== "tui") return;
    if (config.mode === "native") { ctx.ui.setFooter(undefined); return; }
    ctx.ui.setFooter((tui, theme, data) => {
      component?.dispose();
      component = createFooter(tui, theme, data, config, () => snapshot,
        (title, text) => { void ctx.ui.select(`${title}\n\n${text}`, ["关闭"]); });
      return component;
    });
  };
  const failure = (ctx: Context, error: unknown) => ctx.ui.notify(
    `Footer 配置未应用，保留当前显示：${error instanceof Error ? error.message : String(error)}`, "warning");
  pi.registerCommand("footer", {
    description: "查看 stats|tokens|context|more；close 关闭；custom|native 切换；reload 重载配置",
    handler: async (args: string, ctx: Context) => {
      let action = args.trim().toLowerCase();
      if (!action) {
        const items = ["会话统计", "Token 用量", "上下文", "更多", "自定义底栏", "Pi 原生底栏", "重新加载配置"];
        const selected = await ctx.ui.select("Footer", items);
        if (!selected) return;
        action = ["stats", "tokens", "context", "more", "custom", "native", "reload"][items.indexOf(selected)];
      }
      if (["stats", "tokens", "context", "more", "toggle", "expand"].includes(action)) {
        if (config.mode === "native") { ctx.ui.notify("先运行 /footer custom 启用自定义底栏", "info"); return; }
        component?.open((["toggle", "expand"].includes(action) ? "stats" : action) as PanelId); return;
      }
      if (action === "close" || action === "collapse") { component?.close(); return; }
      // 旧视图命令只保留入口兼容，运行时始终使用同一个渲染器。
      if (["custom", "native", "compact", "overview", "reload"].includes(action)) {
        try {
          const next = store.load();
          if (action !== "reload") { next.mode = action === "native" ? "native" : "custom"; store.save(next); }
          config = next; mount(ctx); paint();
          ctx.ui.notify(action === "reload" ? "Footer · 配置已重载" : `Footer · ${config.mode === "native" ? "Pi 原生" : "自定义底栏"} · 已保存`, "info");
        } catch (error) { failure(ctx, error); }
        return;
      }
      ctx.ui.notify("用法: /footer stats|tokens|context|more|close|custom|native|reload", "error");
    },
  });
  pi.on("session_start", (_event, ctx: Context) => {
    stop(); meter.reset(); transient = []; snapshot = emptySnapshot();
    try { config = store.load(); }
    catch (error) { config = defaultFooterConfig(); ctx.ui.notify(`Footer 配置无效，使用默认布局：${error instanceof Error ? error.message : String(error)}`, "warning"); }
    rebuild(ctx); mount(ctx);
  });
  pi.on("session_tree", (_event, ctx: Context) => {
    stop(); meter.reset(); transient = []; component?.close(); snapshot = emptySnapshot(); rebuild(ctx); paint();
  });
  pi.on("agent_start", (_event, ctx: Context) => { activeCtx = ctx; snapshot.working = true; paint(); });
  pi.on("before_provider_request", (_event, ctx: Context) => {
    activeCtx = ctx; refreshContext(snapshot, ctx); meter.start(); paint();
    if (ticker === undefined && ctx.hasUI !== false && (!ctx.mode || ctx.mode === "tui")) {
      ticker = setInterval(() => { if (!activeCtx) { stop(); return; } paint(); }, 250);
      ticker.unref?.();
    }
  });
  pi.on("message_update", event => {
    const wasWaiting = meter.waiting() !== null;
    meter.delta(event.assistantMessageEvent);
    if (wasWaiting && meter.waiting() === null) { stop(); paint(); }
  });
  pi.on("message_end", (event, ctx: Context) => {
    activeCtx = ctx; addMessage(snapshot, event.message);
    if (event.message?.role === "assistant") { persist(meter.finish(event.message)); stop(); }
    paint();
  });
  pi.on("tool_execution_start", event => { if (typeof event.toolCallId === "string") meter.toolStart(event.toolCallId); });
  pi.on("tool_execution_end", event => {
    persist(meter.toolEnd(typeof event.toolCallId === "string" ? event.toolCallId : "", event.durationMs)); paint();
  });
  pi.on("turn_end", (_event, ctx: Context) => { activeCtx = ctx; refreshContext(snapshot, ctx); paint(); });
  pi.on("agent_end", (_event, ctx: Context) => { stop(); meter.reset(); rebuild(ctx); snapshot.working = false; paint(); });
  pi.on("session_compact", (_event, ctx: Context) => { rebuild(ctx); paint(); });
  pi.on("model_select", (event, ctx: Context) => { activeCtx = ctx; refreshContext(snapshot, { ...ctx, model: event.model }); paint(); });
  pi.on("thinking_level_select", event => { snapshot.thinking = cleanText(String(event.level ?? "")).replace(/\n/g, " "); paint(); });
  pi.on("session_shutdown", () => { stop(); meter.reset(); activeCtx = null; component?.dispose(); component = null; });
}
