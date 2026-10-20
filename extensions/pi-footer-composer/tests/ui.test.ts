import assert from "node:assert/strict";
import test from "node:test";
import footerExtension from "../index.ts";
import { createFooter, type MouseEvent } from "../component.ts";
import { defaultFooterConfig } from "../config.ts";
import { emptySnapshot, type Entry } from "../types.ts";
import { visibleWidth } from "../layout.ts";
import { METRIC_TYPE } from "../metrics.ts";
const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text };
function fakeTui() {
  const overlays: any[] = [], listeners = new Set<Function>();
  const tui = {
    mode: "fullscreen", terminal: { columns: 120, rows: 24 }, requests: 0,
    requestRender() { this.requests++; },
    showOverlay(card: any, options: any) {
      const item = { card, options, hidden: false }; overlays.push(item);
      return { hide() { item.hidden = true; }, getBounds: () => ({ row: options.row, col: options.col, width: options.width, height: options.maxHeight }) };
    },
    addInputListener(listener: Function) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { tui, overlays, listeners, input: (raw: string) => [...listeners].map(listener => listener(raw)) };
}
const mouse = (x: number, type = "click", extra = {}): MouseEvent => ({ type, button: "left", x, y: 1, screenX: x, screenY: 22, ...extra });

test("independent popovers switch, toggle, close with Esc, scroll, resize, and release listeners", () => {
  const f = fakeTui(), config = defaultFooterConfig();
  config.more.sections = [{ label: "诊断", status: "diagnostics" }];
  const footer = createFooter(f.tui, theme, { getExtensionStatuses: () => new Map([["diagnostics", "error line\n".repeat(100)]]) }, config, emptySnapshot, () => assert.fail("unexpected fallback"));
  const line = footer.render(120)[1], tokensX = visibleWidth(line.slice(0, line.indexOf("▱"))), contextX = visibleWidth(line.slice(0, line.indexOf("◔")));
  assert.deepEqual(footer.handleMouse(mouse(2, "press")), { handled: true, render: false }); assert.equal(f.overlays.length, 0);
  footer.handleMouse(mouse(2)); assert.equal(f.overlays.length, 1);
  assert.equal(f.overlays[0].options.nonCapturing, true);
  assert.match(f.overlays[0].card.render(54).join("\n"), /会话统计/);
  footer.handleMouse(mouse(tokensX)); assert.equal(f.overlays[0].hidden, true);
  assert.match(f.overlays[1].card.render(54).join("\n"), /Token 用量/);
  assert.equal(f.listeners.size, 1);
  footer.handleMouse(mouse(tokensX)); assert.equal(f.listeners.size, 0);
  footer.handleMouse(mouse(contextX)); f.input("\x1b"); assert.equal(f.listeners.size, 0);
  footer.open("more"); assert.deepEqual(f.input("\x1b"), [{ consume: true }]); assert.equal(f.listeners.size, 0);
  footer.open("more"); let card = f.overlays.at(-1); const before = card.card.render(54).join("\n");
  card.card.handleMouse(mouse(0, "wheel", { wheelDelta: 1 })); assert.notEqual(card.card.render(54).join("\n"), before);
  f.tui.terminal.columns = 32; f.tui.terminal.rows = 16; footer.render(32);
  assert.ok(card.options.col + card.options.width <= 32); assert.ok(card.options.row + card.options.maxHeight <= 12);
  assert.deepEqual(f.input("a"), [undefined]); assert.equal(f.listeners.size, 0);
  for (const extra of [{ ctrl: true }, { button: "right" }, { clickCount: 2 }]) assert.equal(footer.handleMouse(mouse(0, "click", extra)), undefined);
  footer.open("more"); footer.dispose(); assert.equal(f.listeners.size, 0); assert.equal(f.overlays.at(-1).hidden, true); assert.deepEqual(footer.render(80), []);
});

test("host event smoke: branch-local data, persisted timing, cached render, model updates and atomic reload", async () => {
  const handlers = new Map<string, Function>(); let command: Function = () => {};
  const f = fakeTui(), entries: Entry[] = [], notices: string[] = [], components: any[] = [];
  let now = 0, reads = 0, contextReads = 0, fail = false, saves = 0;
  let disk = defaultFooterConfig();
  footerExtension({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (_: string, def: any) => command = def.handler,
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) } as never,
  { now: () => now, configStore: { load: () => { if (fail) throw new Error("bad config"); return structuredClone(disk); }, save: c => { disk = structuredClone(c); saves++; } } });
  const ctx = { hasUI: true, mode: "tui", model: { id: "model", contextWindow: 1000 },
    sessionManager: { getBranch() { reads++; return entries; }, getEntries() { assert.fail("must not scan other branches"); } },
    getContextUsage() { contextReads++; return { tokens: 100, contextWindow: 1000, percent: 10 }; },
    ui: { setFooter(factory: any) { if (factory) components.push(factory(f.tui, theme, { getExtensionStatuses: () => new Map() })); else components.push(null); },
      notify: (text: string) => notices.push(text), select: async () => undefined } };
  const emit = async (name: string, event = {}) => handlers.get(name)!(event, ctx);
  await emit("session_start"); let live = components.at(-1);
  for (let i = 0; i < 100; i++) live.render(120); assert.equal(reads, 1); assert.equal(contextReads, 1);
  const messageEnd = async (message: any) => { await emit("message_end", { message }); entries.push({ type: "message", message }); };
  await emit("agent_start"); await messageEnd({ role: "user" });
  await emit("before_provider_request"); now = 200; await emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "think" } });
  now = 1000; await messageEnd({ role: "assistant", usage: { input: 100, cacheRead: 900, output: 249 } });
  await emit("turn_end"); await emit("agent_end");
  assert.match(live.render(120).join("\n"), /1 轮 1 步 · 249 tok\/s/);
  assert.equal(entries.filter(entry => entry.customType === METRIC_TYPE).length, 1);
  await command("stats", ctx); assert.match(f.overlays.at(-1).card.render(54).join("\n"), /0\.2 秒/);
  await command("close", ctx); assert.equal(f.listeners.size, 0);
  fail = true; const count = components.length; await command("reload", ctx); await command("native", ctx);
  assert.equal(components.length, count); assert.equal(saves, 0); assert.match(notices.at(-1)!, /保留当前显示/);
  fail = false; disk.style.gap = 7; await command("native", ctx); assert.equal(components.at(-1), null); assert.equal(disk.style.gap, 7);
  await command("custom", ctx); live = components.at(-1);
  entries.length = 0; await emit("session_tree"); assert.match(live.render(120).join("\n"), /0 轮 0 步/); assert.doesNotMatch(live.render(120).join("\n"), /249/);
  await emit("model_select", { model: { id: "new model" } }); await command("more", ctx);
  assert.match(f.overlays.at(-1).card.render(54).join("\n"), /new model/);
  await emit("session_shutdown"); assert.deepEqual(live.render(120), []); assert.equal(f.listeners.size, 0);
});
test("regular mode keeps command access without mouse, and older overlay APIs use dialog fallback", () => {
  let called = "";
  const footer = createFooter({ mode: "regular", requestRender() {} }, theme, { getExtensionStatuses: () => new Map() }, defaultFooterConfig(), emptySnapshot, title => called = title);
  footer.render(80); assert.equal(footer.handleMouse(mouse(2)), undefined);
  footer.open("tokens"); assert.equal(called, "Token 用量"); footer.dispose();
});
test("footer margins and overlay separation preserve native hit coordinates", () => {
  const f = fakeTui();
  const footer = createFooter(f.tui, theme, { getExtensionStatuses: () => new Map() }, defaultFooterConfig(), emptySnapshot, () => assert.fail("fallback"));
  const lines = footer.render(120);
  assert.equal(lines.length, 3); assert.equal(lines[0], ""); assert.equal(lines[2], ""); assert.match(lines[1], /^  ◴/);
  assert.equal(footer.handleMouse(mouse(2, "click", { y: 0 })), undefined);
  assert.equal(footer.handleMouse(mouse(2, "click", { y: 2 })), undefined);
  assert.equal(footer.handleMouse(mouse(0)), undefined);
  footer.handleMouse(mouse(2));
  const card = f.overlays.at(-1);
  assert.ok(card.options.col >= 2); assert.ok(card.options.col + card.options.width <= 118);
  assert.ok(card.options.row + card.options.maxHeight <= 20);
  assert.equal(card.card.handleMouse(mouse(card.options.width - 5, "press", { y: 1 })), undefined);
  card.card.handleMouse(mouse(card.options.width - 5, "press", { y: 2 }));
  card.card.handleMouse(mouse(card.options.width - 5, "click", { y: 2 }));
  assert.equal(card.hidden, true); assert.equal(f.listeners.size, 0);
  footer.dispose();
});
test("very short terminals use the dialog instead of overlapping the footer margins", () => {
  const f = fakeTui(); f.tui.terminal.rows = 12;
  let fallback = "";
  const footer = createFooter(f.tui, theme, { getExtensionStatuses: () => new Map() }, defaultFooterConfig(), emptySnapshot, title => fallback = title);
  footer.render(80); footer.open("stats");
  assert.equal(fallback, "会话统计"); assert.equal(f.overlays.length, 0); assert.equal(f.listeners.size, 0);
  footer.dispose();
});
