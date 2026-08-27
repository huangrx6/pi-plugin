import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension from "../index.ts";

test("extension registers lifecycle hooks, four model tools, and /context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-qos-smoke-"));
  const storage = join(cwd, "cold-store");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "context-qos.json"),
    JSON.stringify({ storage: { directory: storage } }),
  );
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const entries: Array<{ type: string; data: unknown }> = [];
  extension({
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  } as any);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["context_recall", "context_search", "context_pin", "context_unpin"],
  );
  assert.ok(commands.has("context"));
  for (const event of [
    "session_start",
    "before_agent_start",
    "turn_start",
    "tool_result",
    "context",
    "turn_end",
    "session_tree",
    "session_compact",
    "session_shutdown",
  ]) {
    assert.ok(handlers.has(event), `missing ${event} handler`);
  }

  const branch: any[] = [{ id: "root", type: "message", message: { role: "user" } }];
  const notifications: string[] = [];
  let compactCalls = 0;
  const ctx = {
    cwd,
    model: { provider: "test", id: "model", contextWindow: 8_000 },
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => join(cwd, "session.jsonl"),
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 8_000, percent: 125 }),
    compact: (options: { onComplete?: () => void }) => {
      compactCalls++;
      options.onComplete?.();
    },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  await handlers.get("session_start")![0]!({ reason: "startup" }, ctx);
  await handlers.get("before_agent_start")![0]!({ prompt: "fix retry binding" }, ctx);
  await handlers.get("turn_start")![0]!({ turnIndex: 0 }, ctx);
  await handlers.get("tool_result")![0]!(
    {
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "npm test" },
      content: [{ type: "text", text: "1 passed" }],
      isError: false,
    },
    ctx,
  );
  branch.push({
    id: "tool-result-entry",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "1 passed" }],
    },
  });
  const contextResult = await handlers.get("context")![0]!(
    {
      messages: [
        { role: "user", content: "fix retry binding" },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          content: [{ type: "text", text: "1 passed" }],
        },
      ],
    },
    ctx,
  );
  assert.equal(contextResult.messages.length, 2);
  assert.equal(compactCalls, 1, "native compaction is the final critical-pressure fallback");
  await handlers.get("turn_end")![0]!({}, ctx);
  assert.equal(entries[0]?.type, "context-qos-checkpoint");
  await commands.get("context").handler("doctor", ctx);
  assert.match(notifications.at(-1) ?? "", /doctor: OK/);
  await handlers.get("session_shutdown")![0]!({}, ctx);
});
