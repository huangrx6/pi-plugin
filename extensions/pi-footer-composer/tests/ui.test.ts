/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import footerExtension from "../index.ts";
import { visibleWidth } from "../layout.ts";

test("full footer is the default; compact and native remain selectable", async () => {
  const handlers = new Map<string, Function>();
  let command: Function | undefined;
  const footerCalls: unknown[] = [];
  const notices: string[] = [];
  let selection: string | undefined;
  footerExtension({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand(_name: string, definition: { handler: Function }) {
      command = definition.handler;
    },
  } as never);

  const ctx = {
    model: { id: "model\u001b]9;bad\u0007", provider: "provider", reasoning: true, contextWindow: 128_000 },
    thinkingLevel: "high",
    sessionManager: {
      getEntries: () => [{ type: "message", message: { role: "assistant", usage: { input: 4000000, output: 147000, cacheRead: 58000000 } } }],
      getCwd: () => "/tmp/project",
      getSessionName: () => "session",
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 128_000, percent: 12 }),
    ui: {
      setFooter: (renderer: unknown) => footerCalls.push(renderer),
      select: async () => selection,
      notify: (message: string) => notices.push(message),
    },
  };
  await handlers.get("session_start")?.({}, ctx);
  const renderer = footerCalls.at(-1) as Function;
  const component = renderer(
    { requestRender() {} },
    { fg: (color: string, text: string) => {
      assert.ok(["text", "muted", "warning", "error", "dim"].includes(color));
      return text;
    }, bold: () => { throw new Error("Footer must use uniform font weight"); } },
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([
        ["config:mode", "⚙ 权限 smart"],
        ["integration:mcp", "🔌 MCP ready"],
        ["quota:account", "⚡GLM 5h: 37%"],
        ["context:summary", "◎ Context 12%"],
        ["context:paused", "◎ Context 12% · 暂停"],
        ["usage:custom", "额外用量 42"],
      ]),
      getAvailableProviderCount: () => 2,
      onBranchChange: () => () => {},
    },
  );
  const full = component.render(200);
  assert.equal(full.length, 7);
  assert.match(full.join("\n"), /状态  /);
  assert.match(full.join("\n"), /模型  model   provider   思考 high/);
  assert.match(full.join("\n"), /窗口  12.0% \/ 128k/);
  assert.match(full.join("\n"), /额度  GLM 5h: 37%/);
  assert.match(full.join("\n"), /累计  输入 4.0M   输出 147k/);
  assert.equal(full.join("\n").match(/Context 12%/g)?.length, 1);
  assert.match(full.join("\n"), /Context 12% · 暂停/);
  assert.match(full.join("\n"), /额外用量 42/);
  assert.match(full.join("\n"), /MCP ready/);
  assert.doesNotMatch(full.join("\n"), /\u001b\]9|bad|│|⚡|🔌|⚙|◎/);
  for (const width of [1, 5, 6, 12, 40, 80, 120]) {
    assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
  }

  await command?.("compact", ctx);
  const fullRenderer = footerCalls.at(-1) as Function;
  const compact = fullRenderer(
    { requestRender() {} },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([
        ["config:mode", "权限 smart"],
        ["integration:mcp", "MCP ready"],
      ]),
      getAvailableProviderCount: () => 1,
      onBranchChange: () => () => {},
    },
  ).render(200);
  assert.equal(compact.length, 3);
  assert.doesNotMatch(compact.join("\n"), /MCP ready/);

  await command?.("native", ctx);
  assert.equal(footerCalls.at(-1), undefined);
  const noticeCount = notices.length;
  selection = undefined;
  await command?.("", ctx);
  assert.equal(notices.length, noticeCount, "cancelling the selector stays quiet");
});
