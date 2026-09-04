/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import footerExtension from "../index.ts";

test("compact footer is the default and native mode restores Pi's footer", async () => {
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
    model: { id: "model\u001b]9;bad\u0007", provider: "provider", contextWindow: 128_000 },
    thinkingLevel: "high",
    sessionManager: {
      getEntries: () => [],
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
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([
        ["config:mode", "权限 smart"],
        ["integration:mcp", "MCP ready"],
      ]),
      getAvailableProviderCount: () => 2,
      onBranchChange: () => () => {},
    },
  );
  const compact = component.render(200);
  assert.equal(compact.length, 3);
  assert.match(compact.join("\n"), /状态：/);
  assert.doesNotMatch(compact.join("\n"), /\u001b\]9/);
  assert.doesNotMatch(compact.join("\n"), /MCP ready/);

  await command?.("full", ctx);
  const fullRenderer = footerCalls.at(-1) as Function;
  const full = fullRenderer(
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
  assert.equal(full.length, 5);

  await command?.("native", ctx);
  assert.equal(footerCalls.at(-1), undefined);
  const noticeCount = notices.length;
  selection = undefined;
  await command?.("", ctx);
  assert.equal(notices.length, noticeCount, "cancelling the selector stays quiet");
});
