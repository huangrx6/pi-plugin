import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension, { formatStatus } from "../index.ts";
import { displayWidth } from "../src/runtime/terminal.ts";
import type { ContextStats } from "../src/types.ts";

test("extension registers lifecycle hooks, ONE model tool, and /context", async () => {
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
  const entryRenderers = new Map<string, any>();
  const entries: Array<{ type: string; data: unknown }> = [];
  extension({
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerEntryRenderer(name: string, renderer: any) {
      entryRenderers.set(name, renderer);
    },
    sendMessage() {},
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

  // v0.2: only context_recall stays as a MODEL tool — the search/pin/
  // unpin schemas were dead weight (0 model invocations across 17 live
  // sessions) and their /context commands are unchanged.
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["context_recall"],
  );
  assert.ok(commands.has("context"));
  assert.ok(entryRenderers.has("context-qos-maintenance"));
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

  const branch: any[] = [
    { id: "root", type: "message", message: { role: "user" } },
  ];
  const notifications: string[] = [];
  let compactCalls = 0;
  const statusUpdates: Array<[string, string]> = [];
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
    getContextUsage: () => ({
      tokens: 10_000,
      contextWindow: 8_000,
      percent: 125,
    }),
    hasUI: true,
    isIdle: () => false,
    hasPendingMessages: () => false,
    compact: (options: { onComplete?: (result: any) => void }) => {
      compactCalls++;
      options.onComplete?.({ tokensBefore: 10_000, estimatedTokensAfter: 2_000 });
    },
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (key: string, text: string) => statusUpdates.push([key, text]),
      select: async (_title: string, options: string[]) =>
        options.find((option) => option.startsWith("stats")),
    },
  };
  await handlers.get("session_start")![0]!({ reason: "startup" }, ctx);
  assert.ok(
    statusUpdates.some(([key]) => key === "context:qos"),
    "session_start must publish the footer status before any model call",
  );
  await handlers.get("before_agent_start")![0]!(
    { prompt: "fix retry binding" },
    ctx,
  );
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
  assert.equal(
    compactCalls,
    1,
    "native compaction is the final critical-pressure fallback",
  );
  const qosUpdates = statusUpdates.filter(([key]) => key === "context:qos");
  assert.ok(
    qosUpdates.length >= 2,
    "status must be published at session_start and again per model call",
  );
  assert.match(
    qosUpdates.at(-1)![1]!,
    /◎QoS \d+%/,
    "the latest publication reflects the critical-pressure plan",
  );
  await handlers.get("turn_end")![0]!({}, ctx);
  assert.ok(entries.some(entry => entry.type === "context-qos-checkpoint"));
  await commands.get("context").handler("doctor", ctx);
  assert.match(notifications.at(-1) ?? "", /doctor: OK/);
  // No-args path opens the picker; our select mock picks "doctor", which
  // needs no argument, so it must execute straight away.
  await commands.get("context").handler("", ctx);
  assert.match(
    notifications.at(-1) ?? "",
    /有效预算/,
    "empty /context offers usage before advanced commands",
  );
  await handlers.get("session_shutdown")![0]!({}, ctx);

  const tones: string[] = [];
  const theme = { fg: (tone: string, text: string) => { tones.push(tone); return text; } };
  const maintenance = entryRenderers.get("context-qos-maintenance")(
    { data: { status: "failed", text: "整理失败\x1b]2;bad\x07，需要检查。", tokensBefore: 2000, tokensAfter: 1000 } },
    { expanded: true },
    theme,
  );
  const maintenanceLines = maintenance.render(10);
  assert.ok(maintenanceLines.every((line: string) => displayWidth(line) <= 10));
  assert.ok(maintenanceLines.every((line: string) => !line.includes("\x1b")));
  assert.equal(tones[0], "warning");

  const recallCall = tools[0].renderCall({ ref: "ctx://item/1\x1b[31mBAD" }, theme);
  const recallLines = recallCall.render(12);
  assert.ok(recallLines.every((line: string) => displayWidth(line) <= 12));
  assert.ok(recallLines.every((line: string) => !line.includes("\x1b")));
});

test("footer status is a minimal icon + percentage cell", () => {
  const base: ContextStats = {
    activeTokens: 621_000,
    rawTokens: 625_000,
    savedTokens: 3_700,
    coldBytes: 102_400,
    itemCount: 84,
    pressure: "red",
    pressureRatio: 0.7,
    frozen: false,
    byTier: {
      pinned: 0,
      working: 0,
      evidence: 6_600,
      historical: 19,
      disposable: 2_000,
    },
    byRepresentation: { raw: 0, extract: 0, summary: 0, tombstone: 0 },
  };
  const text = formatStatus(base);
  assert.ok(!text.includes("\n"), "status is a single line");
  assert.match(text, /◎QoS 70%/, "icon + percentage, no level word");
  assert.ok(!text.includes("("), "no level bracket like (红)");
  assert.ok(!text.includes("活"), "active tokens stay out of the footer");
  assert.ok(!text.includes("省"), "saved tokens stay out of the footer");
  assert.ok(!text.includes("库"), "item count stays out of the footer");
  assert.ok(!text.includes("⚡"), "icon must differ from the quota prefix");
  assert.ok(text.includes("\x1b[31m"), "level is conveyed by color alone");
  assert.ok(!text.includes("冻结"));
  const frozen = formatStatus({ ...base, frozen: true });
  assert.match(frozen, /◎QoS 70%·冻结/);
  const critical = formatStatus({ ...base, pressure: "critical" });
  assert.ok(critical.includes("\x1b[1;31m"), "critical uses bold red");
  assert.match(critical, /◎QoS 70%/);
});
