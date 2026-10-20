import { panelCloseColumn, panelContent, panelInnerWidth, panelLines, panelText, summary, type Hit, type Theme } from "./render.ts";
import type { FooterConfig, PanelId } from "./settings.ts";
import type { Snapshot } from "./types.ts";
export type MouseEvent = { type: string; button: string; x: number; y: number; screenX: number; screenY: number; shift?: boolean; alt?: boolean; ctrl?: boolean; clickCount?: number; wheelDelta?: number };
type MouseResult = { handled: boolean; render?: boolean } | undefined;
type OverlayOptions = { row: number; col: number; width: number; maxHeight: number; nonCapturing: boolean; margin: number; visible: (width: number, height: number) => boolean };
type Component = { render(width: number): string[]; invalidate(): void; handleMouse?(event: MouseEvent): MouseResult };
export type Tui = {
  mode?: string;
  terminal?: { columns: number; rows: number };
  requestRender(force?: boolean): void;
  showOverlay?(component: Component, options: OverlayOptions): { hide(): void };
  addInputListener?(listener: (data: string) => { consume: boolean } | undefined): () => void;
};
export type FooterData = { getExtensionStatuses(): ReadonlyMap<string, string>; onBranchChange?(callback: () => void): () => void };
const plainClick = (e: MouseEvent) => e.button === "left" && !e.shift && !e.alt && !e.ctrl && (e.clickCount ?? 1) === 1;
export function createFooter(tui: Tui, theme: Theme, data: FooterData, config: FooterConfig, snapshot: () => Snapshot, fallback: (title: string, text: string) => void) {
  let active: PanelId | null = null, hits: Hit[] = [], disposed = false, scroll = 0, maxOffset = 0;
  let columns = tui.terminal?.columns ?? 80, bottomDistance = 0;
  let overlay: ReturnType<NonNullable<Tui["showOverlay"]>> | undefined, unlisten: (() => void) | undefined;
  const options: OverlayOptions = { row: 0, col: 0, width: 54, maxHeight: 12, nonCapturing: true, margin: 0, visible: (w, h) => w >= 18 && h >= 7 };
  const refresh = () => tui.requestRender();
  const close = () => {
    active = null; scroll = 0; overlay?.hide(); overlay = undefined;
    unlisten?.(); unlisten = undefined;
    if (!disposed) tui.requestRender(true);
  };
  const place = () => {
    const w = tui.terminal?.columns ?? columns, h = tui.terminal?.rows ?? 24;
    const footerY = Math.max(0, h - 1 - bottomDistance);
    options.width = Math.min(config.style.panelWidth, w);
    const inner = panelInnerWidth(options.width);
    const contentLength = active ? panelContent(active, snapshot(), config, data.getExtensionStatuses(), inner).rows.length : 0;
    options.maxHeight = Math.min(Math.max(6, footerY), contentLength + 4);
    options.row = Math.max(0, footerY - options.maxHeight);
    options.col = Math.max(0, Math.min(hits.find(hit => hit.id === active)?.x ?? 0, w - options.width));
  };
  const scrollBy = (delta: number) => { scroll = Math.min(maxOffset, Math.max(0, scroll + delta)); refresh(); };
  const card: Component = {
    render(width) {
      if (!active || disposed) return [];
      const result = panelLines(active, snapshot(), config, data.getExtensionStatuses(), width, options.maxHeight, scroll, theme);
      maxOffset = result.maxOffset; scroll = Math.min(scroll, maxOffset);
      return result.lines;
    },
    invalidate() {},
    handleMouse(event) {
      if (event.type === "wheel") { scrollBy((event.wheelDelta ?? 0) > 0 ? 3 : -3); return { handled: true }; }
      if (!plainClick(event)) return undefined;
      if (event.y === 1 && Math.abs(event.x - panelCloseColumn(options.width)) <= 1) {
        if (event.type === "click") close();
        if (event.type === "press" || event.type === "click") return { handled: true, render: event.type === "click" };
      }
      // 文本区不认领按下事件，保留宿主的鼠标选中文本行为。
      return undefined;
    },
  };
  const open = (id: PanelId) => {
    if (disposed) return;
    if (active === id) { close(); return; }
    close();
    if (!tui.showOverlay || !tui.addInputListener || (tui.terminal?.columns ?? columns) < 18 || (tui.terminal?.rows ?? 24) < 7) {
      const content = panelContent(id, snapshot(), config, data.getExtensionStatuses(), 64);
      fallback(content.title, panelText(content)); return;
    }
    active = id; place();
    overlay = tui.showOverlay(card, options);
    unlisten = tui.addInputListener(raw => {
      if (!active) return undefined;
      if (raw === "\x1b") { close(); return { consume: true }; }
      // 普通键仍交给编辑器，浮层不抢焦点；编辑开始时自动收起。
      if (!raw.startsWith("\x1b[<") && !raw.startsWith("\x1b[")) close();
      return undefined;
    });
    refresh();
  };
  const unsubscribe = data.onBranchChange?.(refresh);
  return {
    render(width: number) {
      if (disposed || width <= 0) return [];
      columns = width;
      const result = summary(snapshot(), config, width, active, theme); hits = result.hits;
      if (active) place();
      return [result.line];
    },
    invalidate() {},
    handleMouse(event: MouseEvent): MouseResult {
      if (disposed || tui.mode === "regular" || event.y !== 0 || !plainClick(event)) return undefined;
      const hit = hits.find(hit => event.x >= hit.x && event.x < hit.x + hit.width);
      if (!hit) return undefined;
      if (event.type === "press") return { handled: true, render: false };
      if (event.type !== "click") return undefined;
      bottomDistance = Math.max(0, (tui.terminal?.rows ?? 24) - 1 - event.screenY);
      open(hit.id); return { handled: true, render: true };
    },
    open, close, refresh,
    dispose() { disposed = true; close(); unsubscribe?.(); },
  };
}
