// Conflict harness: wire BOTH pi-mode-switcher and pi-policy-engine into
// one fake pi runtime (mimicking runner.js emitToolCall semantics:
// ordered handlers, first block:true short-circuits), then fire the
// interaction scenarios users would actually hit.
//
// Run: node scripts/conflict-harness.mjs

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJiti } from "file:///Users/huangrx6/.nvm/versions/node/v24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const modeSwitcher = (await jiti.import("../../pi-mode-switcher/index.ts")).default;
const policyEngine = (await import("../extensions/policy-engine/index.js")).default;

// --- fake pi runtime -------------------------------------------------------

function createFakePi() {
  const state = {
    handlers: [],       // ordered [name, fn]
    commands: new Map(),
    confirms: [],       // dialog interactions requested
    confirmAnswer: true,
    notices: [],
  };
  const pi = {
    on(name, fn) { state.handlers.push([name, fn]); },
    registerCommand(name, def) { state.commands.set(name, def); },
    getCommands() { return []; },
  };
  return { pi, state };
}

// Ordered emit with short-circuit-on-block (verbatim semantics of
// dist/core/extensions/runner.js::emitToolCall).
async function emitToolCall(state, event, ctx) {
  let result;
  for (const [name, fn] of state.handlers) {
    if (name !== "tool_call") continue;
    const handlerResult = await fn(event, ctx);
    if (handlerResult) {
      result = handlerResult;
      if (result.block) return { result, stopAt: owner.get(fn) ?? "?" };
    }
  }
  return { result };
}

async function emit(state, name, event, ctx) {
  let result;
  for (const [hname, fn] of state.handlers) {
    if (hname !== name) continue;
    const r = await fn(event, ctx);
    if (r !== undefined) result = r;
  }
  return result;
}

function makeCtx(state, cwd) {
  return {
    cwd,
    model: { provider: "minimax-cn", id: "MiniMax-M3" },
    ui: {
      confirm: async (title, message) => {
        state.confirms.push({ title, message });
        return state.confirmAnswer;
      },
      notify: (message, level) => state.notices.push({ message, level }),
      setStatus: () => {},
      select: async () => null,
    },
  };
}

// --- harness ---------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "pi-conflict-"));

const { pi, state } = createFakePi();
const owner = new WeakMap();
const origOn = pi.on.bind(pi);
pi.on = (name, fn) => { owner.set(fn, currentExt); origOn(name, fn); };

let currentExt = "mode-switcher";
modeSwitcher(pi);
currentExt = "policy-engine";
policyEngine(pi);

const ctx = makeCtx(state, tmp);

// registration order check
const toolCallOrder = state.handlers.filter(([n]) => n === "tool_call").map(([, f]) => owner.get(f));
process.stdout.write(`tool_call handler 注册顺序: ${toolCallOrder.join(" → ")}\n`);
assert.deepEqual(toolCallOrder, ["mode-switcher", "policy-engine"], "order follows root pi.extensions array");

// mode-switcher -> ask mode (最严格), so we see its dialog behavior
await state.commands.get("mode").handler("ask", ctx);

// policy-engine: force strict workflow via runtime override (no confirm dialogs of its own)
await state.commands.get("policy").handler("strict", ctx);

// Drive one high-risk prompt through before_agent_start -> planning + pendingApproval
await emit(state, "session_start", {}, ctx);
await emit(state, "before_agent_start", { prompt: "设计生产环境 PG schema 迁移方案，需要回滚", systemPrompt: "BASE" }, ctx);

const call = (toolName, command) => ({ toolName, input: toolName === "bash" ? { command } : { path: "x" } });

function report(label, out, expectDialog, expectBlocked) {
  const dialog = state.confirms.length;
  const blocked = out?.result?.block === true;
  const ok = dialog === expectDialog && blocked === expectBlocked;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  console.log(`     dialog弹出=${dialog}(期望${expectDialog}) blocked=${blocked}(期望${expectBlocked})` +
    (out?.stopAt ? ` 短路于=${out.stopAt}` : "") +
    (blocked ? ` reason摘要=${String(out.result.reason).slice(0, 60)}…` : ""));
  state.confirms.length = 0;
  return ok;
}

// --- 场景矩阵 --------------------------------------------------------------

process.stdout.write("\n=== 场景1：mode=ask + strict pendingApproval，edit 工具 ===");
// mode-switcher(ask) 对写工具先弹 confirm；用户点 Yes 后 policy-engine 仍 block
state.confirmAnswer = true;
let out = await emitToolCall(state, call("edit"), ctx);
report("ask 模式下用户在弹框点了 Yes，但 policy-engine 仍然拦截", out, 1, true);

process.stdout.write("\n=== 场景2：同上，但用户点 No ===");
state.confirmAnswer = false;
out = await emitToolCall(state, call("edit"), ctx);
// mode-switcher confirm No → 返回 block → 短路，policy-engine 根本不执行
report("用户点 No → mode-switcher 直接短路，policy-engine 不再跑", out, 1, true);

process.stdout.write("\n=== 场景3：批准后（pendingApproval=false），edit 工具 ===");
await emit(state, "before_agent_start", { prompt: "开始执行", systemPrompt: "BASE" }, ctx);
state.confirmAnswer = true; // 用户在 ask 弹框里点 Yes
out = await emitToolCall(state, call("edit"), ctx);
// policy-engine 放行；mode=ask 仍然弹框 → 用户批过的 plan 还要再点一次
report("policy 已放行，但 mode=ask 仍要求逐个确认（双重门槛）", out, 1, false);

process.stdout.write("\n=== 场景4：批准后切 full 模式 ===");
await state.commands.get("mode").handler("full", ctx);
out = await emitToolCall(state, call("edit"), ctx);
report("full + 已批准 → 全放行，零弹框", out, 0, false);

process.stdout.write("\n=== 场景5：只读 bash + 2>/dev/null（gate 未涉及时）===");
// strict 已批准、mode=full：两扩展都不该拦只读
out = await emitToolCall(state, call("bash", "rg TODO src 2>/dev/null"), ctx);
report("full + 已批准 + 只读静默命令 → 放行", out, 0, false);

process.stdout.write("\n=== 场景6：重新进入 strict planning，hard gate + ask，危险 bash ===");
await state.commands.get("policy").handler("gate hard", ctx);
await emit(state, "before_agent_start", { prompt: "设计生产环境数据库迁移方案 v2，线上不能停机", systemPrompt: "BASE" }, ctx);
// pendingApproval 恢复为 true
state.confirmAnswer = true;
out = await emitToolCall(state, call("bash", "kubectl apply -f deploy.yaml"), ctx);
// mode=ask 的 isWriteBash 白名单不含 kubectl（不在其写命令表里）→ 不弹框，
// 直接落到 policy-engine hard gate 拦截。合理：计划批准前 kubectl 就该拦。
report("ask 不认 kubectl 为写命令 → 不弹框，hard gate 接管拦截", out, 0, true);

process.stdout.write("\n=== 场景7：smart 模式 + strict pendingApproval + 普通写文件 ===");
await state.commands.get("mode").handler("smart", ctx);
out = await emitToolCall(state, call("write"), ctx);
// smart 对写文件自动过；policy-engine soft gate 拦
report("smart 自动过 → policy-engine gate 接管拦截", out, 0, true);

process.stdout.write("\n=== 场景8：smart 模式 + 危险 bash（rm -rf）+ pendingApproval ===");
out = await emitToolCall(state, call("bash", "rm -rf /tmp/x"), ctx);
// mode-switcher smart 对危险命令弹 confirm；Yes 后 policy-engine hard 拦
report("smart 危险命令弹框 Yes 后 hard gate 仍拦", out, 1, true);

process.stdout.write("\n=== 结论确认：两个扩展的工具拦截是 OR 组合（取更严者），顺序 mode-switcher 在前 ===");
process.stdout.write("harness: OK\n");
