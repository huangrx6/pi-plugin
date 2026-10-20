import { PANEL_CHROME_HEIGHT, PANEL_MIN_HEIGHT, panelCloseButton, panelContent, panelInnerWidth, panelLines, panelText, summary, type Hit, type Theme } from "./render.ts";
import { keyboardAction, observeDismissInput, type InputSource } from "./input.ts";
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
  showOverlay?(component: Component, options: OverlayOptions): { hide(): void; getBounds?(): { row: number; col: number; width: number; height: number } | undefined };
  addInputListener?(listener: (data: string) => { consume: boolean } | undefined): () => void;
};
export type FooterData = { getExtensionStatuses(): ReadonlyMap<string, string>; onBranchChange?(callback: () => void): () => void };
const PANEL_MARGIN = 2, PANEL_GAP = 0;
const plainClick = (e: MouseEvent) => e.button === "left" && !e.shift && !e.alt && !e.ctrl && (e.clickCount ?? 1) === 1;
export function createFooter(tui: Tui, theme: Theme, data: FooterData, config: FooterConfig, snapshot: () => Snapshot, fallback: (title: string, text: string) => void, input: InputSource = process.stdin) {
  let active: PanelId | null = null, hits: Hit[] = [], disposed = false, scroll = 0, maxOffset = 0;
  let columns = tui.terminal?.columns ?? 80, bottomInset = 0, summaryRow = 1, footerHeight = 2;
  let overlay: ReturnType<NonNullable<Tui["showOverlay"]>> | undefined, unlisten: (() => void) | undefined, unobserve: (() => void) | undefined;
  let generation = 0;
  const hasRoom = (w: number, h: number) => w >= 18 + 2 * PANEL_MARGIN && h - footerHeight - PANEL_GAP - 1 >= PANEL_MIN_HEIGHT + 1;
  const options: OverlayOptions = { row: 0, col: 0, width: config.style.panelWidth, maxHeight: 14, nonCapturing: true, margin: 0, visible: hasRoom };
  const refresh = () => tui.requestRender();
  const close = () => {
    generation++; active = null; scroll = 0; overlay?.hide(); overlay = undefined;
    unlisten?.(); unlisten = undefined;
    unobserve?.(); unobserve = undefined;
    if (!disposed) tui.requestRender(true);
  };
  const place = () => {
    const w = tui.terminal?.columns ?? columns, h = tui.terminal?.rows ?? 24;
    const footerTop = Math.max(0, h - bottomInset - footerHeight);
    options.width = Math.min(config.style.panelWidth, Math.max(1, w - 2 * PANEL_MARGIN));
    const inner = panelInnerWidth(options.width);
    const contentLength = active ? panelContent(active, snapshot(), config, data.getExtensionStatuses(), inner).rows.length : 0;
    options.maxHeight = Math.min(Math.max(0, footerTop - PANEL_GAP - 1), contentLength + PANEL_CHROME_HEIGHT);
    options.row = Math.max(1, footerTop - PANEL_GAP - options.maxHeight);
    options.col = Math.max(PANEL_MARGIN, Math.min(hits.find(hit => hit.id === active)?.x ?? PANEL_MARGIN, w - PANEL_MARGIN - options.width));
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
      const button = panelCloseButton(options.width, config.icons);
      if (Math.abs(event.y - button.row) <= 1 && event.x >= button.column - 1 && event.x <= button.column + button.width) {
        if (event.type === "click") close();
        if (event.type === "press" || event.type === "click") return { handled: true, render: event.type === "click" };
      }
      return undefined;
    },
  };
  const open = (id: PanelId) => {
    if (disposed) return;
    if (active === id) { close(); return; }
    close();
    if (!tui.showOverlay || !tui.addInputListener || !hasRoom(tui.terminal?.columns ?? columns, tui.terminal?.rows ?? 24)) {
      const content = panelContent(id, snapshot(), config, data.getExtensionStatuses(), 64);
      fallback(content.title, panelText(content)); return;
    }
    active = id; place();
    overlay = tui.showOverlay(card, options);
    const opened = generation;
    unobserve = observeDismissInput(input, event => {
      // A host callback can switch the card during this same stdin emission.
      if (!active || opened !== generation) return;
      if (event.type === "blur") { close(); return; }
      const footerY = (tui.terminal?.rows ?? 24) - bottomInset - footerHeight + summaryRow;
      if (event.y === footerY && hits.some(hit => event.x >= hit.x && event.x < hit.x + hit.width)) return;
      const bounds = overlay?.getBounds?.() ?? { row: options.row, col: options.col, width: options.width, height: options.maxHeight };
      if (event.x < bounds.col || event.x >= bounds.col + bounds.width || event.y < bounds.row || event.y >= bounds.row + bounds.height) close();
    });
    unlisten = tui.addInputListener(raw => {
      if (!active) return undefined;
      const action = keyboardAction(raw);
      if (action === "escape") { close(); return { consume: true }; }
      if (action === "edit") close();
      return undefined;
    });
    refresh();
  };
  const unsubscribe = data.onBranchChange?.(refresh);
  return {
    render(width: number) {
      if (disposed || width <= 0) return [];
      columns = width;
      summaryRow = (tui.terminal?.rows ?? 24) >= 8 ? 1 : 0;
      footerHeight = 1 + summaryRow;
      const result = summary(snapshot(), config, width, active, theme);
      hits = result.hits;
      if (active) place();
      if (!summaryRow) return [result.line];
      const rule = (config.icons === "ascii" ? "-" : "─").repeat(width);
      const divider = theme.getThinkingBorderColor
        ? theme.getThinkingBorderColor(snapshot().thinking || "off")(rule)
        : theme.fg("border", rule);
      return [divider, result.line];
    },
    invalidate() {},
    handleMouse(event: MouseEvent): MouseResult {
      if (disposed || tui.mode === "regular" || event.y !== summaryRow || !plainClick(event)) return undefined;
      const hit = hits.find(hit => event.x >= hit.x && event.x < hit.x + hit.width);
      if (!hit) return undefined;
      if (event.type === "press") return { handled: true, render: false };
      if (event.type !== "click") return undefined;
      const screenBottom = event.screenY - event.y + footerHeight - 1;
      bottomInset = Math.max(0, (tui.terminal?.rows ?? 24) - 1 - screenBottom);
      open(hit.id); return { handled: true, render: true };
    },
    open, close, refresh,
    dispose() { disposed = true; close(); unsubscribe?.(); },
  };
}
