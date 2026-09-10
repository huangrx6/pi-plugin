import assert from "node:assert/strict";
import test from "node:test";
import footerExtension from "../index.ts";
import { resolveFooterConfig } from "../config.ts";
import { visibleWidth } from "../layout.ts";

test("configured views render through Pi; reload is atomic and switching preserves external edits", async () => {
  const handlers = new Map<string, Function>();
  let command: Function = () => {};
  const footerCalls: any[] = [], notices: string[] = [], saved: any[] = [];
  let failedLoad = false;
  let disk = resolveFooterConfig({ mode: "overview" });
  disk.views.compact.rows = [
    [{ label: "项目", fields: ["project", "branch"] }, { label: "模型", fields: ["model", "provider", "thinking"] }],
    [{ label: "资源", fields: ["context", "cacheHit", "input", "output", "cacheRead", "cost"] }, { label: "额度", fields: [{ status: "pi-quota-status" }] }],
    [{ label: "策略", fields: [{ status: "pi-policy-engine" }] }, { label: "诊断", fields: [{ status: "diagnostics" }] }],
    [{ label: "状态", fields: [{ status: "pi-mode-switcher" }] }, { label: "集成", fields: [{ status: "external" }] }],
  ];
  footerExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: { handler: Function }) => { command = definition.handler; },
  } as never, { configStore: {
    load: () => { if (failedLoad) throw new Error("views.compact.rows[0]: 无效"); return structuredClone(disk); },
    save: config => { disk = structuredClone(config); saved.push(config); },
  } });
  const statuses = new Map([
    ["pi-mode-switcher", "审批 完全访问权限"], ["pi-policy-engine", "policy:auto ↑922 ↓69"],
    ["diagnostics", "LSP 3 errors · 12 warnings\nmain.ts · api.ts"], ["external", "MCP ready"],
    ["context:summary", "Context 12%"], ["context:paused", "Context 12% · 暂停"],
    ["pi-quota-status", "GLM 5h: 37%"], ["usage:custom", "额外用量 42"],
  ]);
  const ctx = {
    model: { id: "model\x1b]9;bad\x07", provider: "provider", reasoning: true, contextWindow: 128000 },
    thinkingLevel: "high",
    sessionManager: {
      getEntries: () => [{ type: "message", message: { role: "assistant", usage: { input: 4000000, output: 147000, cacheRead: 58000000 } } }],
      getCwd: () => "/tmp/project", getSessionName: () => "session",
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 128000, percent: 12 }),
    ui: { setFooter: (factory: any) => footerCalls.push(factory), notify: (text: string) => notices.push(text), select: async () => undefined },
  };
  const component = () => footerCalls.at(-1)({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {
    getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {},
  });
  await handlers.get("session_start")!({}, ctx);
  const overview = component().render(200).join("\n");
  for (const text of ["project", "provider", "high", "↑4.0M", "读58M", "◎93.5%", "policy:auto ↑922 ↓69", "额外用量 42"]) assert.ok(overview.includes(text), text);
  assert.equal(overview.match(/Context 12%/g)?.length, 1);
  assert.doesNotMatch(overview, /bad|\x1b|│/);
  await command("compact", ctx);
  const compactComponent = component();
  const compact = compactComponent.render(200).join("\n");
  assert.match(compact, /项目 │ project +main.*模型 │ model/);
  assert.match(compact, /策略 │ policy:auto ↑922 ↓69.*诊断 │ LSP/);
  assert.equal(compact.match(/policy:auto/g)?.length, 1);
  assert.match(compact, /main.ts · api.ts/);
  assert.match(compact, /资源 │ 12\.0% \/ 128k +◎93\.5% +↑4\.0M +↓147k +读58M/);
  assert.doesNotMatch(compact, /额外用量|\/tmp\/project/);
  for (const width of [1, 30, 60, 72, 100, 200]) assert.ok(compactComponent.render(width).every((line: string) => visibleWidth(line) <= width));

  disk.views.compact.rows = [[{ label: "自定", fields: ["model", { status: "diagnostics" }] }]];
  disk.style.borders = "none";
  await command("reload", ctx);
  assert.match(component().render(120).join("\n"), /自定 │ model/);
  assert.doesNotMatch(component().render(120).join("\n"), /[┬┴┼]/);
  const count = footerCalls.length, saves = saved.length;
  failedLoad = true;
  await command("reload", ctx); await command("overview", ctx);
  assert.equal(footerCalls.length, count); assert.equal(saved.length, saves);
  assert.match(notices.at(-1)!, /保留当前显示.*rows\[0\]/);
  failedLoad = false;
  disk.style.columnGap = 7;
  await command("native", ctx);
  assert.equal(footerCalls.at(-1), undefined);
  assert.equal(saved.at(-1).style.columnGap, 7);
  assert.deepEqual(saved.at(-1).views.compact.rows, disk.views.compact.rows);
  const noticeCount = notices.length;
  await command("", ctx); assert.equal(notices.length, noticeCount);
  disk.mode = "compact"; await command("reload", ctx);
  const live = component();
  await handlers.get("model_select")!({ model: { id: "new-model" } }, ctx);
  assert.match(live.render(120).join("\n"), /new-model/);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.deepEqual(live.render(120), []);
});
