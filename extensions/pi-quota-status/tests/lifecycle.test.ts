import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../index.ts";
import { createMonitor } from "../monitor.ts";
import { buildQuotaText } from "../format.ts";
import { quotaDetails, quotaDiagnostics } from "../panel.ts";

const model = { provider: "deepseek", baseUrl: "https://api.deepseek.com" };
const balance = (amount: string) => new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: amount }] }));
function credentials(t, name = "DEEPSEEK_API_KEY", value = "fixture-A") {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}
function pendingFetch(t) {
  const calls: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise<Response>(resolve => calls.push({ resolve, signal: options.signal })));
  return calls;
}

test("switching to an unsupported provider cancels and rejects a late response", async t => {
  credentials(t);
  const calls = pendingFetch(t);
  const monitor = createMonitor();
  const published: unknown[] = [];
  const publish = () => published.push(buildQuotaText(monitor.state));
  const first = monitor.refresh(model, publish);
  await monitor.refresh({ provider: "unsupported" }, publish);
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(balance("9"));
  await first;
  assert.equal(monitor.state.quotaData, null);
  assert.equal(published.at(-1), null);
});

test("missing key invalidates a pending request before the early return", async t => {
  credentials(t);
  const calls = pendingFetch(t);
  const monitor = createMonitor();
  const first = monitor.refresh(model, () => {});
  delete process.env.DEEPSEEK_API_KEY;
  await monitor.refresh(model, () => {});
  calls[0].resolve(balance("9"));
  await first;
  assert.equal(monitor.state.quotaData, null);
  assert.match(monitor.state.errorText, /未配置/);
});

test("key rotation has its own identity and an older successful response cannot win", async t => {
  credentials(t);
  const calls = pendingFetch(t);
  const monitor = createMonitor();
  const first = monitor.refresh(model, () => {});
  process.env.DEEPSEEK_API_KEY = "fixture-B";
  assert.equal(monitor.matches(model), false);
  const second = monitor.refresh(model, () => {});
  calls[1].resolve(balance("22"));
  await second;
  calls[0].resolve(balance("11"));
  await first;
  assert.match(buildQuotaText(monitor.state)!, /22\.00/);
  assert.doesNotMatch(JSON.stringify(monitor.state), /fixture-A|fixture-B/);
});

test("a credential changed during fetch is rechecked even without another event", async t => {
  credentials(t);
  const calls = pendingFetch(t);
  const monitor = createMonitor();
  const first = monitor.refresh(model, () => {});
  process.env.DEEPSEEK_API_KEY = "rotated";
  calls[0].resolve(balance("11"));
  await first;
  assert.equal(monitor.state.quotaData, null);
  assert.match(monitor.state.errorText, /凭证已变化/);
});

test("shutdown invalidation prevents publishing after cleanup", async t => {
  credentials(t);
  const calls = pendingFetch(t);
  const monitor = createMonitor();
  let publishes = 0;
  const first = monitor.refresh(model, () => ++publishes);
  monitor.invalidate();
  const before = publishes;
  calls[0].resolve(balance("12"));
  await first;
  assert.equal(publishes, before);
  assert.equal(monitor.state.quotaData, null);
});

test("same-account transient failure is explicitly stale immediately, authentication failure clears it", async t => {
  credentials(t);
  let phase = 0;
  t.mock.method(globalThis, "fetch", async () => phase === 0 ? balance("12") : new Response("{}", { status: phase === 1 ? 503 : 401 }));
  const monitor = createMonitor();
  await monitor.refresh(model, () => {});
  phase = 1;
  await monitor.refresh(model, () => {});
  assert.match(buildQuotaText(monitor.state)!, /12\.00/);
  assert.match(buildQuotaText(monitor.state)!, /\?/);
  assert.match(quotaDetails(monitor.state, monitor.adapter, model), /刷新失败.*上次成功值/);
  phase = 2;
  await monitor.refresh(model, () => {});
  assert.equal(monitor.state.quotaData, null);
  assert.match(monitor.state.errorText, /401/);
});

test("changed credentials and base URLs cannot reuse stale money", async t => {
  credentials(t);
  t.mock.method(globalThis, "fetch", async () => balance("12"));
  const monitor = createMonitor();
  await monitor.refresh(model, () => {});
  await monitor.refresh({ ...model, baseUrl: "https://proxy.invalid" }, () => {});
  assert.equal(monitor.state.quotaData, null);
  assert.match(monitor.state.errorText, /端点未适配/);
});

test("/quota independently opens details and refreshes without a custom footer", async t => {
  credentials(t);
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => balance(String(++reads)));
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command) });
  const panels: string[] = [];
  const selections = ["刷新", "关闭"];
  const ctx = { model, hasUI: true, ui: {
    setStatus() {}, notify() {},
    async select(title) { panels.push(title); return selections.shift(); },
  } };
  await commands.get("quota").handler("", ctx);
  assert.equal(reads, 2);
  assert.equal(panels.length, 2);
  assert.match(panels[0], /额度 \/ DeepSeek API\n账户余额/);
  assert.match(panels[1], /¥2\.00/);
  assert.doesNotMatch(panels[1], /api.deepseek.com/);
});

test("/quota keeps diagnostics secondary and non-TUI output non-interactive", async t => {
  credentials(t);
  t.mock.method(globalThis, "fetch", async () => balance("12"));
  const commands = new Map<string, any>();
  extension({ on() {}, registerCommand: (name, command) => commands.set(name, command) });
  const notices: string[] = [];
  let selects = 0;
  const ctx = { model, mode: "rpc", hasUI: true, ui: {
    setStatus() {}, notify(message) { notices.push(message); },
    async select() { ++selects; return "关闭"; },
  } };
  await commands.get("quota").handler("", ctx);
  assert.equal(selects, 0);
  assert.match(notices[0], /额度 \/ DeepSeek API/);
  assert.doesNotMatch(notices[0], /api.deepseek.com/);
  await commands.get("quota").handler("sources", ctx);
  assert.match(notices[1], /数据来源与诊断/);
  assert.match(notices[1], /api.deepseek.com/);
  assert.match(quotaDiagnostics(undefined, { provider: "bad\x1b]52;c;x\x07 provider" }), /bad provider/);
});

test("/quota account only reads the explicit management key, never the inference key", async t => {
  credentials(t, "OPENROUTER_API_KEY", "inference-only");
  credentials(t, "OPENROUTER_MANAGEMENT_KEY", "");
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => { ++reads; throw new Error("must not query"); });
  const commands = new Map<string, any>();
  extension({ on() {}, registerCommand: (name, command) => commands.set(name, command) });
  let panel = "";
  await commands.get("quota").handler("account", { model: { provider: "openrouter" }, hasUI: true, ui: { setStatus() {}, notify() {}, async select(text) { panel = text; return "关闭"; } } });
  assert.equal(reads, 0);
  assert.match(panel, /未配置 OPENROUTER_MANAGEMENT_KEY/);
  assert.doesNotMatch(panel, /inference-only/);
});

test("shutdown during command refresh does not open a panel in the old session", async t => {
  credentials(t);
  const calls = pendingFetch(t);
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command) });
  let panels = 0;
  const ctx = { model, hasUI: true, ui: { setStatus() {}, notify() {}, async select() { ++panels; return "关闭"; } } };
  const command = commands.get("quota").handler("", ctx);
  handlers.get("session_shutdown")!({}, ctx);
  calls[0].resolve(balance("12"));
  await command;
  assert.equal(panels, 0);
});
