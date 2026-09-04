import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, { contextUsage, formatStatus } from "../index.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-compact-extension-"));
  mkdirSync(join(root, ".pi")); writeFileSync(join(root, ".pi", "auto-compact.json"), JSON.stringify({ enabled: true, thresholdPercent: 60 }));
  const handlers = new Map<string, Function>(); const commands = new Map<string, any>(); const entries: any[] = []; const messages: any[] = []; const notices: string[] = [];
  const callbacks: any[] = []; const rows: string[][] = [];
  const state = { idle: false, pending: false, session: "one", usage: { tokens: 60, contextWindow: 100 } as any, pick: undefined as any };
  const ctx = { cwd: root, hasUI: true, model: { contextWindow: 100 }, getContextUsage: () => state.usage, getSystemPrompt: () => "Base",
    isProjectTrusted: () => true, isIdle: () => state.idle, hasPendingMessages: () => state.pending,
    sessionManager: { getSessionId: () => state.session }, compact: (options: any) => callbacks.push(options),
    ui: { notify: (s: string) => notices.push(s), setStatus() {}, select: async (_title: string, choices: string[]) => { rows.push(choices); return state.pick; } } };
  const pi = { on: (event: string, callback: Function) => handlers.set(event, callback), registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer() {}, appendEntry: (type: string, data: any) => entries.push({ type, data }), sendMessage: (message: any, options: any) => messages.push({ message, options }),
    registerTool() { throw new Error("No model tools should be registered"); } };
  extension(pi as any);
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start", { reason: "new" }); emit("before_agent_start", { prompt: "Finish the task" });
  return { root, state, ctx, messages, entries, notices, callbacks, rows, emit, handlers,
    command: (args: string) => commands.get("context").handler(args, ctx),
    close() { emit("session_shutdown"); rmSync(root, { recursive: true, force: true }); } };
}

test("only full-window host usage triggers native compaction; messages stay untouched", () => {
  const h = harness(); try {
    const messages = [{ role: "toolResult", content: [{ type: "text", text: "full evidence" }] }]; const event = { messages };
    h.state.usage.tokens = 59; assert.equal(h.emit("context", event), undefined); assert.equal(h.callbacks.length, 0);
    h.state.usage.tokens = 60; assert.equal(h.emit("context", event), undefined); assert.equal(h.callbacks.length, 1);
    assert.deepEqual(messages, [{ role: "toolResult", content: [{ type: "text", text: "full evidence" }] }]);
    assert.ok(!h.handlers.has("tool_result")); assert.deepEqual(readdirSync(h.root), [".pi"]);
    h.state.idle = true; h.callbacks[0].onComplete({ tokensBefore: 60, estimatedTokensAfter: 60 });
    h.state.idle = false; h.emit("before_agent_start", { prompt: "Continue" }); h.emit("context", event);
    assert.equal(h.callbacks.length, 1, "a successful no-op compaction cannot loop through agent start");
    assert.equal(h.messages.length, 1); assert.equal(h.messages[0].options.triggerTurn, true);
  } finally { h.close(); }
});
test("unknown usage is displayed honestly and never starts compaction", () => {
  const h = harness(); try {
    for (const usage of [undefined, { tokens: null, contextWindow: 100 }, { tokens: 90, contextWindow: 0 }, { tokens: NaN, contextWindow: 100 }, { tokens: 90 }]) {
      h.state.usage = usage; h.emit("context"); assert.equal(contextUsage(h.ctx), undefined);
    }
    assert.equal(h.callbacks.length, 0); assert.match(formatStatus(undefined, { enabled: true, thresholdPercent: 60 }), /未知/);
  } finally { h.close(); }
});
for (const event of ["input", "session_before_switch", "session_before_fork", "session_before_tree", "session_tree", "model_select"]) {
  test(`${event} invalidates old automatic continuation`, () => {
    const h = harness(); try { h.emit("context"); h.emit(event); h.state.idle = true; h.callbacks[0].onComplete({ tokensBefore: 60 }); assert.equal(h.messages.length, 0); } finally { h.close(); }
  });
}
test("panel has three actions, cancellation is silent and removed commands give usage", async () => {
  const h = harness(); try {
    await h.command(""); assert.equal(h.rows[0].length, 3); assert.equal(h.notices.length, 0);
    await h.command("recall 外层 README 不再"); assert.match(h.notices.at(-1)!, /可用操作/);
    await h.command("pause"); h.emit("context"); assert.equal(h.callbacks.length, 0);
    await h.command("threshold 70"); await h.command("resume"); h.emit("context"); assert.equal(h.callbacks.length, 0);
    h.state.usage.tokens = 70; h.emit("context"); assert.equal(h.callbacks.length, 1);
    assert.deepEqual(readdirSync(h.root), [".pi"]);
  } finally { h.close(); }
});

for (const command of ["pause", "resume", "threshold 70"]) {
  test(`${command} during compaction changes future triggers without abandoning the interrupted task`, async () => {
    const h = harness(); try {
      h.emit("context"); await h.command(command); h.state.idle = true;
      h.callbacks[0].onComplete({ tokensBefore: 60, estimatedTokensAfter: 20 });
      assert.equal(h.messages.length, 1); assert.equal(h.entries.at(-1).data.status, "resumed");
    } finally { h.close(); }
  });
}
