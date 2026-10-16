import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { SAMPLE_TYPE } from "../constants.ts";
import { loadConfig } from "../config.ts";
import type { ThroughputSample } from "../types.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description: string; handler: Handler }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(name: string, definition: { description: string; handler: Handler }) {
      commands.set(name, definition);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
  };
  async function emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  }
  async function run(name: string, args: string, ctx: unknown): Promise<void> {
    const command = commands.get(name);
    assert.ok(command, `command ${name} is registered`);
    await command.handler(args, ctx);
  }
  return { pi, emit, run, entries };
}

function createCtx(options: {
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  entries?: unknown[];
  selectAnswers?: Array<string | undefined>;
} = {}) {
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notices: string[] = [];
  const selects: string[] = [];
  const answers = [...(options.selectAnswers ?? [])];
  const ctx = {
    model: { id: "deepseek-v4.1-flash", provider: "opencode-go" },
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    sessionManager: { getBranch: () => options.entries ?? [] },
    ui: {
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
      },
      notify(message: string) {
        notices.push(message);
      },
      async select(title: string) {
        selects.push(title);
        return answers.shift();
      },
    },
  };
  return { ctx, statuses, notices, selects };
}

function withAgentDir(t: { after(fn: () => void): void }): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "pi-throughput-life-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { PI_CODING_AGENT_DIR: dir };
}

const assistantEnd = (usageOutput: number) => ({
  type: "message_end",
  message: {
    role: "assistant",
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
    usage: { output: usageOutput },
    stopReason: "stop",
  },
});

const delta = (output: number) => ({
  type: "message_update",
  assistantMessageEvent: {
    type: "text_delta",
    partial: { content: [{ type: "text", text: "hello" }], usage: { output } },
  },
});

const sample: ThroughputSample = {
  at: 1_700_000_000_000,
  provider: "opencode-go",
  model: "deepseek-v4.1-flash",
  tokens: 120,
  estimated: false,
  ttftMs: 380,
  streamMs: 1800,
  e2eMs: 2180,
  aborted: false,
};

test("one call walks placeholder → live → final and records a sample", async (t) => {
  withAgentDir(t);
  const { pi, emit, entries } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", { type: "session_start" }, ctx);
  await emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
  assert.equal(statuses.at(-1)?.key, "pi-throughput");
  assert.equal(statuses.at(-1)?.text, "⠋ 等待首 token…");

  await emit("message_update", delta(8), ctx);
  assert.match(statuses.at(-1)?.text ?? "", /^首 token \d+ms$/);

  await emit("message_end", assistantEnd(50), ctx);
  assert.match(statuses.at(-1)?.text ?? "", /^[\d.]+ t\/s · 首 token \d+ms$/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, SAMPLE_TYPE);
  const recorded = entries[0]?.data as ThroughputSample;
  assert.equal(recorded.tokens, 50);
  assert.equal(recorded.model, "deepseek-v4.1-flash");
  assert.equal(typeof recorded.ttftMs, "number");
});

test("display can be switched off without losing sample history", async (t) => {
  withAgentDir(t);
  const { pi, emit, run, entries } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", { type: "session_start" }, ctx);
  await run("throughput", "off", ctx);
  assert.equal(statuses.at(-1)?.text, undefined);

  await emit("before_provider_request", {}, ctx);
  await emit("message_update", delta(12), ctx);
  await emit("message_end", assistantEnd(12), ctx);
  assert.equal(entries.length, 1);

  await run("throughput", "on", ctx);
  assert.match(statuses.at(-1)?.text ?? "", /t\/s · 首 token /);
});

test("command subcommands persist configuration", async (t) => {
  const env = withAgentDir(t);
  const { pi, run } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, notices } = createCtx();

  await run("throughput", "measurement e2e", ctx);
  await run("throughput", "display ttft", ctx);
  await run("throughput", "retain off", ctx);
  assert.deepEqual(
    { measurement: loadConfig(env).measurement, display: loadConfig(env).display, retainFinal: loadConfig(env).retainFinal },
    { measurement: "e2e", display: "ttft", retainFinal: false },
  );

  await run("throughput", "reload", ctx);
  assert.equal(notices.at(-1)?.includes("端到端"), true);

  await run("throughput", "bogus", ctx);
  assert.match(notices.at(-1) ?? "", /\/throughput/);
});

test("stats reads samples from the session branch", async (t) => {
  withAgentDir(t);
  const { pi, run } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, selects } = createCtx({
    entries: [{ type: "custom", customType: SAMPLE_TYPE, data: sample }],
  });

  await run("throughput", "stats", ctx);
  assert.match(selects.at(-1) ?? "", /调用 1 次/);
  assert.match(selects.at(-1) ?? "", /deepseek-v4\.1-flash/);
});

test("stats outside the TUI reports empty history without throwing", async (t) => {
  withAgentDir(t);
  const { pi, run } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, notices } = createCtx({ mode: "print", hasUI: false });

  await run("throughput", "stats", ctx);
  assert.match(notices.at(-1) ?? "", /尚未记录调用样本/);
});

test("non-TUI contexts never receive status writes", async (t) => {
  withAgentDir(t);
  const { pi, emit } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx({ mode: "json", hasUI: false });

  await emit("session_start", {}, ctx);
  await emit("before_provider_request", {}, ctx);
  await emit("message_update", delta(3), ctx);
  await emit("message_end", assistantEnd(3), ctx);
  assert.deepEqual(statuses, []);
});

test("the TUI panel toggles settings and exits on close", async (t) => {
  const env = withAgentDir(t);
  const { pi, run } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx } = createCtx({ selectAnswers: ["状态显示：开", "关闭"] });

  await run("throughput", "", ctx);
  assert.equal(loadConfig(env).enabled, false);
});

test("session shutdown clears the published status", async (t) => {
  withAgentDir(t);
  const { pi, emit } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", {}, ctx);
  await emit("before_provider_request", {}, ctx);
  await emit("session_shutdown", {}, ctx);
  assert.equal(statuses.at(-1)?.text, undefined);
});

test("retainFinal keeps the final text after agent_end, otherwise it clears", async (t) => {
  withAgentDir(t);
  const { pi, emit } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", {}, ctx);
  await emit("before_provider_request", {}, ctx);
  await emit("message_update", delta(30), ctx);
  await emit("message_end", assistantEnd(30), ctx);
  const final = statuses.at(-1)?.text;
  await emit("agent_end", { type: "agent_end" }, ctx);
  assert.equal(statuses.at(-1)?.text, final);

  await emit("session_start", {}, ctx);
  const { pi: pi2, emit: emit2 } = createFakePi();
  extension(pi2 as unknown as ExtensionAPI);
  const second = createCtx();
  await emit2("session_start", {}, second.ctx);
  assert.equal(second.statuses.at(-1)?.text, undefined);
});
