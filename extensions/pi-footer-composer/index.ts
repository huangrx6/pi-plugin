/** Pi public data → configured fields and rows → one table renderer. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectSnapshot, type DataContext, type Model } from "./data.ts";
import { composeRows } from "./compose.ts";
import { renderBands } from "./bands.ts";
import { renderTable } from "./table.ts";
import { createFooterConfigStore, defaultFooterConfig, type FooterConfigStore, type FooterMode } from "./config.ts";

type Theme = { fg(color: string, text: string): string; bold(text: string): string };
type FooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};
type Renderer = (tui: { requestRender(): void }, theme: Theme, data: FooterData) => {
  render(width: number): string[]; invalidate(): void; dispose(): void;
};
type Context = DataContext & {
  model?: Model; thinkingLevel?: string;
  ui: { setFooter(renderer: Renderer | undefined): void; select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, level?: string): void };
};

export default function (pi: ExtensionAPI, options: { configStore?: FooterConfigStore } = {}): void {
  const store = options.configStore ?? createFooterConfigStore();
  let config = defaultFooterConfig();
  let activeCtx: Context | null = null;
  let model: Model = null;
  let thinking: string | undefined;
  let requestRender: (() => void) | null = null;

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
      const renderRequest = () => tui.requestRender();
      requestRender = renderRequest;
      const unsubscribe = data.onBranchChange(renderRequest);
      return {
        render(width) {
          if (!activeCtx) return [];
          const snapshot = collectSnapshot(activeCtx, model, thinking, data.getGitBranch(), data.getExtensionStatuses());
          const view = config.views[config.mode === "overview" ? "overview" : "compact"];
          const style = { ...config.style, ...view.style };
          const rows = composeRows(view, snapshot);
          return view.renderer === "bands"
            ? renderBands(rows, width, style, theme, view.showLabels)
            : renderTable(rows, width, style, theme, view.showLabels);
        },
        invalidate() {},
        dispose() { unsubscribe(); if (requestRender === renderRequest) requestRender = null; },
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
      mount(ctx);
      ctx.ui.notify("Footer · 配置已重新加载", "info");
    } catch (error) { failure(ctx, error); }
  };
  const switchMode = (mode: FooterMode, ctx: Context) => {
    // Read the latest file before saving so external layout edits aren't overwritten.
    let next;
    try { next = { ...store.load(), mode }; } catch (error) { failure(ctx, error); return; }
    config = next;
    mount(ctx);
    try {
      store.save(next);
      ctx.ui.notify(`Footer · ${modeLabel(mode)} · 已保存`, "info");
    } catch (error) {
      ctx.ui.notify(`Footer 已切换，但配置保存失败：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  };
  pi.registerCommand("footer", {
    description: "选择 Footer 视图或重新加载 config.json",
    handler: async (args: string, ctx: Context) => {
      const value = String(args || "").trim().toLowerCase();
      if (value === "reload") { reload(ctx); return; }
      if (value === "compact" || value === "overview" || value === "native") { switchMode(value, ctx); return; }
      if (value) { ctx.ui.notify("用法: /footer compact|overview|native|reload", "error"); return; }
      const choices = ["紧凑 · 两列表格速览", "概览 · 三行信息带", "Pi 原生 · 停用自定义 Footer", "重新加载 · 应用 config.json 修改"];
      const selected = await ctx.ui.select(`Footer（当前：${modeLabel(config.mode)}）`, choices);
      const index = selected ? choices.indexOf(selected) : -1;
      if (index >= 0 && index <= 2) switchMode((["compact", "overview", "native"] as const)[index], ctx);
      if (index === 3) reload(ctx);
    },
  });
  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = rawCtx as Context;
    try { config = store.load(); }
    catch (error) {
      config = defaultFooterConfig();
      ctx.ui.notify(`Footer 配置无效，使用默认布局：${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    mount(ctx);
  });
  pi.on("model_select", async (event, ctx) => { model = event.model ?? null; activeCtx = ctx as Context; requestRender?.(); });
  pi.on("thinking_level_select", async event => { thinking = event.level; requestRender?.(); });
  pi.on("turn_end", async () => { requestRender?.(); });
  pi.on("session_shutdown", async () => { activeCtx = null; model = null; thinking = undefined; requestRender = null; });
}
