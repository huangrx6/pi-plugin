/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import footerExtension from "../index.ts";
import { visibleWidth } from "../layout.ts";

test("configured full footer renders and compact/native selections persist", async () => {
  const handlers = new Map<string, Function>();
  let command: Function | undefined;
  const footerCalls: unknown[] = [];
  const notices: string[] = [];
  let selection: string | undefined;
  let branch: string | null = "main";
  const savedModes: string[] = [];
  footerExtension({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerCommand(_name: string, definition: { handler: Function }) {
      command = definition.handler;
    },
  } as never, {
    configStore: {
      load: () => ({ mode: "full" }),
      save: ({ mode }) => savedModes.push(mode),
    },
  });

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
      getGitBranch: () => branch,
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
  assert.ok(full[0].startsWith("──────┬"));
  assert.ok(full.at(-1).startsWith("──────┴"));
  assert.equal(full.length, 15, "seven category rows and eight horizontal rules");
  assert.match(full.join("\n"), /状态 │/);
  assert.match(full.join("\n"), /模型 │ model.*平台  provider.*思考 high/);
  assert.match(full.join("\n"), /平台  provider/);
  assert.match(full.join("\n"), /思考 high/);
  assert.match(full.join("\n"), /分支  main/);
  assert.match(full.join("\n"), /会话  session/);
  assert.match(full.join("\n"), /窗口 │ 12.0% \/ 128k/);
  assert.match(full.join("\n"), /额度 │ GLM 5h: 37%/);
  assert.match(full.join("\n"), /用量 │ 输入 4.0M.*输出 147k.*缓存读 58M/);
  assert.match(full.join("\n"), /缓存读 58M.*命中 93.5%/);
  assert.match(full.join("\n"), /输入 4.0M/);
  assert.match(full.join("\n"), /输出 147k/);
  assert.equal(full.join("\n").match(/Context 12%/g)?.length, 1);
  assert.match(full.join("\n"), /Context 12% · 暂停/);
  assert.match(full.join("\n"), /额外用量 42/);
  assert.match(full.join("\n"), /MCP ready/);
  assert.doesNotMatch(full.join("\n"), /\u001b\]9|bad|⚡|🔌|⚙|◎/);
  for (const width of [1, 5, 6, 12, 40, 80, 120]) {
    assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
  }
  branch = null;
  const withoutBranch = component.render(200).join("\n");
  assert.match(withoutBranch, /会话  session/);
  assert.doesNotMatch(withoutBranch, /分支/);

  await command?.("compact", ctx);
  assert.deepEqual(savedModes, ["compact"]);
  const fullRenderer = footerCalls.at(-1) as Function;
  const compact = fullRenderer(
    { requestRender() {} },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    {
      getGitBranch: () => "main",
      getExtensionStatuses: () => new Map([
        ["config:mode", "权限 smart"],
        ["integration:mcp", "MCP ready"],
        ["quota:account", "GLM 5h: 37%"],
      ]),
      getAvailableProviderCount: () => 1,
      onBranchChange: () => () => {},
    },
  ).render(200);
  assert.equal(compact.length, 7, "three category rows and four horizontal rules");
  assert.ok(compact[0].startsWith("──────┬"));
  assert.ok(compact.at(-1)?.startsWith("──────┴"));
  assert.match(compact.join("\n"), /路径 │ \/tmp\/project.*分支  main.*会话  session/);
  assert.match(compact.join("\n"), /模型 │ model.*思考 high.*额度  GLM 5h: 37%/);
  assert.match(compact.join("\n"), /状态 │ 上下文 12.0% \/ 128k.*命中 93.5%.*权限 smart/);
  assert.doesNotMatch(compact.join("\n"), /MCP ready/);

  await command?.("native", ctx);
  assert.deepEqual(savedModes, ["compact", "native"]);
  assert.equal(footerCalls.at(-1), undefined);
  const noticeCount = notices.length;
  selection = undefined;
  await command?.("", ctx);
  assert.equal(notices.length, noticeCount, "cancelling the selector stays quiet");
});
