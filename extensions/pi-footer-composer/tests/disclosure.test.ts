import assert from "node:assert/strict";
import test from "node:test";
import { disclosureText, isDisclosureClick } from "../disclosure.ts";
import { visibleWidth } from "../layout.ts";
import { resolveFooterConfig } from "../config.ts";
import footerExtension from "../index.ts";

test("the collapsed summary stays on one clean line across narrow and wide terminals", () => {
  const snapshot = { fields: { project: "项目\nname", model: "model\x1b[31m", context: "25.6% / 1.0M" }, statuses: [] };
  for (const width of [0, 1, 2, 10, 30, 80, 200]) {
    const text = disclosureText(snapshot, true, width);
    assert.ok(visibleWidth(text) <= width, text);
    assert.doesNotMatch(text, /\n|\x1b/);
  }
  assert.match(disclosureText(snapshot, true, 200), /详情（点击展开）.*项目 name.*ctx: 25\.6%/);
  assert.equal(disclosureText(snapshot, false, 200), "▾ 收起详情");
  assert.match(disclosureText(snapshot, true, 200, false), /\/footer toggle/);
  assert.doesNotMatch(disclosureText(snapshot, true, 200, false), /点击/);
});

test("only an unmodified single left click on the heading toggles disclosure", () => {
  const click = { type: "click", button: "left", x: 5, y: 0, width: 100 };
  assert.equal(isDisclosureClick(click), true);
  for (const change of [
    { type: "press" }, { type: "release" }, { type: "wheel" }, { type: "drag" },
    { button: "right" }, { y: 1 }, { x: -1 }, { x: 100 },
    { shift: true }, { alt: true }, { ctrl: true }, { clickCount: 2 },
  ]) assert.equal(isDisclosureClick({ ...click, ...change }), false);
});

test("old configs collapse by default; clicks preserve details and never write preferences", async () => {
  const handlers = new Map<string, Function>();
  let command: Function = () => {};
  let factory: any;
  let saves = 0;
  let renders: Array<boolean | undefined> = [];
  let unsubscribed = 0;
  const disk = resolveFooterConfig({ views: { compact: { rows: [[{ label: "细节", fields: ["remaining"] }]] } } });
  assert.equal(disk.collapsed, true);
  const store = { load: () => structuredClone(disk), save: () => { saves += 1; } };
  footerExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: { handler: Function }) => { command = definition.handler; },
  } as never, { configStore: store });
  const statuses = new Map([["diagnostics", "LSP Active: python, markdown\nmain.ts: details"]]);
  const ctx = {
    model: { id: "model", provider: "provider" },
    sessionManager: { getEntries: () => [], getCwd: () => "/tmp/project", getSessionName: () => "session" },
    getContextUsage: () => ({ percent: 25.6, contextWindow: 1000000, tokens: 256000 }),
    ui: { setFooter: (next: any) => { factory = next; }, notify() {}, select: async () => undefined },
  };
  await handlers.get("session_start")!({}, ctx);
  const createComponent = () => factory({ requestRender(force?: boolean) { renders.push(force); } }, { fg: (_color: string, text: string) => text }, {
    getGitBranch: () => "main", getExtensionStatuses: () => statuses,
    onBranchChange: () => () => { unsubscribed += 1; },
  });
  const component = createComponent();
  assert.equal(component.render(120).length, 1);
  assert.doesNotMatch(component.render(120).join("\n"), /LSP/);
  const click = { type: "click", button: "left", x: 2, y: 0, width: 120 };
  assert.deepEqual(component.handleMouse({ ...click, type: "press" }), { handled: true, render: false });
  assert.equal(component.render(120).length, 1);
  assert.deepEqual(component.handleMouse(click), { handled: true, render: true });
  assert.match(component.render(120).join("\n"), /LSP Active.*\n.*main.ts/);
  assert.equal(renders.at(-1), true);
  assert.equal(component.handleMouse({ ...click, y: 2 }), undefined);
  component.handleMouse(click);
  assert.equal(component.render(120).length, 1);
  assert.equal(saves, 0);
  statuses.set("diagnostics", "updated detail");
  await command("expand", ctx);
  assert.match(component.render(120).join("\n"), /updated detail/);
  await command("collapse", ctx);
  assert.equal(component.render(120).length, 1);
  await command("toggle", ctx);
  assert.ok(component.render(120).length > 1);
  await handlers.get("session_start")!({}, { ...ctx });
  const replacement = createComponent();
  assert.equal(replacement.render(120).length, 1);
  component.dispose();
  assert.equal(unsubscribed, 1);
  assert.equal(component.handleMouse(click), undefined);
  assert.equal(replacement.render(120).length, 1);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(replacement.render(120), []);
});
