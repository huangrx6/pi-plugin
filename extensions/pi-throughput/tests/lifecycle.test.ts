import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { SAMPLE_TYPE, TOOL_SAMPLE_TYPE } from "../constants.ts";
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

test("one call walks placeholder → waiting → persistent metrics and records a sample", async (t) => {
  withAgentDir(t);
  const { pi, emit, entries } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", { type: "session_start" }, ctx);
  assert.equal(statuses.at(-1)?.key, "pi-throughput");
  assert.equal(statuses.at(-1)?.text, "llm: -- · tools: -- · ttft: -- · rate: --");

  await emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
  assert.match(statuses.at(-1)?.text ?? "", /· wait \d+ms$/);

  await emit("message_update", delta(8), ctx);
  assert.doesNotMatch(statuses.at(-1)?.text ?? "", /wait /);

  await emit("message_end", assistantEnd(50), ctx);
  assert.match(
    statuses.at(-1)?.text ?? "",
    /^llm: \d+ms · tools: -- · ttft: \d+ms · rate: [\d.]+ t\/s$/,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, SAMPLE_TYPE);
  const recorded = entries[0]?.data as ThroughputSample;
  assert.equal(recorded.tokens, 50);
  assert.equal(recorded.model, "deepseek-v4.1-flash");
  assert.equal(typeof recorded.ttftMs, "number");

  // 响应结束不再清空：四项统计是会话级常驻值。
  const final = statuses.at(-1)?.text;
  await emit("agent_end", { type: "agent_end" }, ctx);
  assert.equal(statuses.at(-1)?.text, final);
});

test("tool time is recorded and joins the persistent line", async (t) => {
  withAgentDir(t);
  const { pi, emit, entries } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", {}, ctx);
  await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "c1", toolName: "read", durationMs: 1500 }, ctx);
  assert.match(statuses.at(-1)?.text ?? "", /tools: 1\.5s/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, TOOL_SAMPLE_TYPE);
  assert.equal((entries[0]?.data as { durationMs: number }).durationMs, 1500);

  // 宿主没给 durationMs（工具没真跑）时不计入，也不写记录。
  await emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "c2" }, ctx);
  assert.equal(entries.length, 1);
});

test("tool time runs from dispatch to result, not the host's execute-only duration", async (t) => {
  withAgentDir(t);
  const { pi, emit } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", {}, ctx);
  await emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "c9", toolName: "bash" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 25));
  // 宿主只报 execute() 的 1ms；会话口径要的是派发到结果的整段墙钟。
  await emit(
    "tool_execution_end",
    { type: "tool_execution_end", toolCallId: "c9", toolName: "bash", durationMs: 1, isError: false },
    ctx,
  );
  const text = statuses.at(-1)?.text ?? "";
  const measured = Number(/tools: (\d+)ms/.exec(text)?.[1]);
  assert.ok(measured >= 20, text);
});

test("a cancelled call is recorded but does not spend model time", async (t) => {
  withAgentDir(t);
  const { pi, emit, entries } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", {}, ctx);
  await emit("before_provider_request", {}, ctx);
  await emit("message_update", delta(5), ctx);
  await emit(
    "message_end",
    { type: "message_end", message: { role: "assistant", usage: { output: 5 }, stopReason: "aborted" } },
    ctx,
  );
  assert.equal(statuses.at(-1)?.text, "llm: -- · tools: -- · ttft: -- · rate: --");
  assert.equal(entries.length, 1);
  assert.equal((entries[0]?.data as ThroughputSample).aborted, true);
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
  assert.match(statuses.at(-1)?.text ?? "", /rate: /);
});

test("command subcommands persist configuration", async (t) => {
  const env = withAgentDir(t);
  const { pi, run } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, notices } = createCtx();

  await run("throughput", "measurement e2e", ctx);
  await run("throughput", "display ttft", ctx);
  await run("throughput", "history off", ctx);
  assert.deepEqual(
    { measurement: loadConfig(env).measurement, display: loadConfig(env).display, history: loadConfig(env).history },
    { measurement: "e2e", display: "ttft", history: false },
  );

  // retainFinal 已随 0.8.0 常驻化下线：旧子命令不再写任何配置。
  await run("throughput", "retain off", ctx);
  assert.equal("retainFinal" in loadConfig(env), false);

  await run("throughput", "reload", ctx);
  assert.equal(notices.at(-1)?.includes("端到端"), true);

  await run("throughput", "bogus", ctx);
  assert.match(notices.at(-1) ?? "", /\/throughput/);
});

test("stats reads samples from the session branch and includes tool time", async (t) => {
  withAgentDir(t);
  const { pi, emit, run } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, selects } = createCtx({
    entries: [
      { type: "custom", customType: SAMPLE_TYPE, data: sample },
      { type: "custom", customType: TOOL_SAMPLE_TYPE, data: { at: 1, durationMs: 3000 } },
    ],
  });

  await emit("session_start", {}, ctx);
  await run("throughput", "stats", ctx);
  assert.match(selects.at(-1) ?? "", /调用 1 次/);
  assert.match(selects.at(-1) ?? "", /工具调用用时 3\.0s/);
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

test("metrics survive agent_end and a new session re-seeds from its own branch", async (t) => {
  withAgentDir(t);
  const { pi, emit } = createFakePi();
  extension(pi as unknown as ExtensionAPI);
  const { ctx, statuses } = createCtx();

  await emit("session_start", {}, ctx);
  await emit("before_provider_request", {}, ctx);
  await emit("message_update", delta(30), ctx);
  await emit("message_end", assistantEnd(30), ctx);
  const final = statuses.at(-1)?.text;
  assert.match(final ?? "", /^llm: .+ · tools: -- · ttft: .+ · rate: .+ t\/s$/);
  await emit("agent_end", { type: "agent_end" }, ctx);
  assert.equal(statuses.at(-1)?.text, final);

  // 新会话没有历史：回到占位符，不拿上一个会话的数字充数。
  const empty = createCtx();
  await emit("session_start", {}, empty.ctx);
  assert.equal(empty.statuses.at(-1)?.text, "llm: -- · tools: -- · ttft: -- · rate: --");

  // 恢复的会话：从分支重建四项指标，不重复计入。
  const resumed = createCtx({
    entries: [
      { type: "custom", customType: SAMPLE_TYPE, data: sample },
      { type: "custom", customType: TOOL_SAMPLE_TYPE, data: { at: 1, durationMs: 3000 } },
    ],
  });
  await emit("session_start", {}, resumed.ctx);
  assert.equal(
    resumed.statuses.at(-1)?.text,
    "llm: 2.2s · tools: 3.0s · ttft: 380ms · rate: 66.7 t/s",
  );
});
