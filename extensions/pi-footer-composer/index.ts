/** Pi public data → configured fields and rows → one table renderer. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectSnapshot, type DataContext, type Model } from "./data.ts";
import { composeRows } from "./compose.ts";
import { renderBands } from "./bands.ts";
import { renderTable } from "./table.ts";
import { disclosureText, isDisclosureClick, type FooterMouseEvent } from "./disclosure.ts";
import { createFooterConfigStore, defaultFooterConfig, type FooterConfigStore, type FooterMode } from "./config.ts";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type FooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};
type Renderer = (tui: { requestRender(force?: boolean): void; mode?: "regular" | "fullscreen" }, theme: Theme, data: FooterData) => {
  render(width: number): string[]; invalidate(): void; dispose(): void;
  handleMouse?(event: FooterMouseEvent): { handled: boolean; render: boolean } | undefined;
};
type Context = DataContext & {
  model?: Model; thinkingLevel?: string;
  ui: { setFooter(renderer: Renderer | undefined): void; select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, level?: string): void };
};

export default function (pi: ExtensionAPI, options: { configStore?: FooterConfigStore } = {}): void {
  const store = options.configStore ?? createFooterConfigStore();
  let config = defaultFooterConfig();
  let collapsed = config.collapsed;
  let activeCtx: Context | null = null;
  let model: Model = null;
  let thinking: string | undefined;
  let requestRender: ((force?: boolean) => void) | null = null;

  const placeholderUi = (
    pi as unknown as { ui?: { setFooter?: (renderer: unknown) => void } }
  ).ui;
  placeholderUi?.setFooter?.(() => ({
    render: () => [],
    invalidate() {},
    dispose() {},
  }));

  const mount = (ctx: Context) => {
    activeCtx = ctx; model = ctx.model ?? null; thinking = ctx.thinkingLevel;
    requestRender = null;
    if (config.mode === "native") { ctx.ui.setFooter(undefined); return; }
    ctx.ui.setFooter((tui, theme, data) => {
      const renderRequest = (force = false) => tui.requestRender(force);
      requestRender = renderRequest;
      const unsubscribe = data.onBranchChange(renderRequest);
      let disposed = false;
      return {
        render(width) {
          if (!activeCtx || disposed) return [];
          const snapshot = collectSnapshot(activeCtx, model, thinking, data.getGitBranch(), data.getExtensionStatuses());
          const heading = disclosureText(snapshot, collapsed, width, tui.mode !== "regular");
          if (!heading) return [];
          const header = theme.fg(config.style.textColor, heading);
          if (collapsed) return [header];
          const view = config.views[config.mode === "overview" ? "overview" : "compact"];
          const style = { ...config.style, ...view.style };
          const rows = composeRows(view, snapshot);
          const details = view.renderer === "bands"
            ? renderBands(rows, width, style, theme, view.showLabels)
            : renderTable(rows, width, style, theme, view.showLabels);
          return [header, ...details];
        },
        handleMouse(event) {
          if (!activeCtx || disposed) return undefined;
          // Pi 在命中按下事件后才向同一组件派发 click；按下只认领，不展开、不抢焦点。
          if (event.type === "press" && isDisclosureClick({ ...event, type: "click" })) {
            return { handled: true, render: false };
          }
          if (!isDisclosureClick(event)) return undefined;
          collapsed = !collapsed;
          // 高度收缩时强制刷新，清掉旧详情占用的终端行。
          tui.requestRender(true);
          return { handled: true, render: true };
        },
        invalidate() {},
        dispose() { disposed = true; unsubscribe(); if (requestRender === renderRequest) requestRender = null; },
      };
    });
  };
  const failure = (ctx: Context, error: unknown) => ctx.ui.notify(
    `Footer 配置未应用，保留当前显示：${error instanceof Error ? error.message : String(error)}`, "warning",
  );
  const modeLabel = (mode: FooterMode) => mode === "compact" ? "紧凑" : mode === "overview" ? "概览" : "Pi 原生";
  const reload = (ctx: Context) => {
    try {
      const next = store.load();
      config = next;
      collapsed = next.collapsed;
      mount(ctx);
      ctx.ui.notify("Footer · 配置已重新加载", "info");
    } catch (error) { failure(ctx, error); }
  };
  const switchMode = (mode: FooterMode, ctx: Context) => {
    // Read the latest file before saving so external layout edits aren't overwritten.
    let next;
    try { next = { ...store.load(), mode }; } catch (error) { failure(ctx, error); return; }
    config = next;
    collapsed = false;
    mount(ctx);
    try {
      store.save(next);
      ctx.ui.notify(`Footer · ${modeLabel(mode)} · 已保存`, "info");
    } catch (error) {
      ctx.ui.notify(`Footer 已切换，但配置保存失败：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };
  pi.registerCommand("footer", {
    description: "点击或 toggle 展开/收起 Footer；选择视图或重新加载 config.json",
    handler: async (args: string, ctx: Context) => {
      const value = String(args || "").trim().toLowerCase();
      if (value === "toggle" || value === "expand" || value === "collapse") {
        if (config.mode === "native") { ctx.ui.notify("Pi 原生底栏不提供详情折叠；先选择 compact 或 overview", "info"); return; }
        collapsed = value === "toggle" ? !collapsed : value === "collapse";
        requestRender?.(true);
        return;
      }
      if (value === "reload") { reload(ctx); return; }
      if (value === "compact" || value === "overview" || value === "native") { switchMode(value, ctx); return; }
      if (value) { ctx.ui.notify("用法: /footer toggle|expand|collapse|compact|overview|native|reload", "error"); return; }
      const choices = ["紧凑 · 两列表格速览", "概览 · 信息带", "Pi 原生 · 停用自定义 Footer", "重新加载 · 应用 config.json 修改", collapsed ? "展开详情" : "收起详情"];
      const selected = await ctx.ui.select(`Footer（当前：${modeLabel(config.mode)}）`, choices);
      const index = selected ? choices.indexOf(selected) : -1;
      if (index >= 0 && index <= 2) switchMode((["compact", "overview", "native"] as const)[index], ctx);
      if (index === 3) reload(ctx);
      if (index === 4 && config.mode !== "native") { collapsed = !collapsed; requestRender?.(true); }
    },
  });
  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = rawCtx as Context;
    try { config = store.load(); }
    catch (error) {
      config = defaultFooterConfig();
      ctx.ui.notify(`Footer 配置无效，使用默认布局：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    collapsed = config.collapsed;
    mount(ctx);
  });
  pi.on("model_select", async (event, ctx) => { model = event.model ?? null; activeCtx = ctx as Context; requestRender?.(); });
  pi.on("thinking_level_select", async event => { thinking = event.level; requestRender?.(); });
  pi.on("turn_end", async () => { requestRender?.(); });
  pi.on("session_shutdown", async () => { activeCtx = null; model = null; thinking = undefined; requestRender = null; });
}
