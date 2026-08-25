import assert from "node:assert/strict";
import policyEngine from "../extensions/policy-engine/index.js";

const handlers = new Map();
const commands = new Map();
const pi = {
  on(name, fn) {
    handlers.set(name, fn);
  },
  registerCommand(name, def) {
    commands.set(name, def);
  },
};

policyEngine(pi);
assert.ok(handlers.has("before_agent_start"));
assert.ok(handlers.has("tool_call"));
assert.ok(commands.has("policy"));

const notices = [];
const statuses = [];
const ctx = {
  cwd: process.cwd(),
  model: { provider: "minimax-cn", id: "MiniMax-M3" },
  ui: {
    notify(message, level) { notices.push({ message, level }); },
    setStatus(key, value) { statuses.push({ key, value }); },
  },
};

await handlers.get("session_start")({}, ctx);

const quick = await handlers.get("before_agent_start")({
  prompt: "只改 README 中的一处描述",
  systemPrompt: "BASE",
}, ctx);
assert.match(quick.systemPrompt, /Workflow: quick/);
assert.match(quick.systemPrompt, /MiniMax M3 Adaptation/);

await handlers.get("agent_end")({}, ctx);

await commands.get("policy").handler("gate hard", ctx);

const strict = await handlers.get("before_agent_start")({
  prompt: "设计生产环境 PostgreSQL 数据库迁移方案并实施，不能停机，需要回滚",
  systemPrompt: "BASE",
}, ctx);
assert.match(strict.systemPrompt, /Workflow: strict/);
assert.match(strict.systemPrompt, /Phase: planning/);
assert.match(strict.systemPrompt, /PLAN-ONLY/);

const blockedEdit = await handlers.get("tool_call")({ toolName: "edit", input: { path: "x" } }, ctx);
assert.equal(blockedEdit?.block, true);

const blockedShell = await handlers.get("tool_call")({ toolName: "bash", input: { command: "kubectl apply -f x.yaml" } }, ctx);
assert.equal(blockedShell?.block, true);

const planFollowUp = await handlers.get("before_agent_start")({
  prompt: "为什么第二步要这样做？",
  systemPrompt: "BASE",
}, ctx);
assert.match(planFollowUp.systemPrompt, /Phase: planning/);
assert.match(planFollowUp.systemPrompt, /do not execute until explicit approval/i);

const allowedRead = await handlers.get("tool_call")({ toolName: "bash", input: { command: "git diff --stat" } }, ctx);
assert.equal(allowedRead, undefined);

const approved = await handlers.get("before_agent_start")({
  prompt: "开始执行，按这个计划做",
  systemPrompt: "BASE",
}, ctx);
assert.match(approved.systemPrompt, /Phase: executing/);
assert.match(approved.systemPrompt, /plan has been approved/i);

const editAfterApproval = await handlers.get("tool_call")({ toolName: "edit", input: { path: "x" } }, ctx);
assert.equal(editAfterApproval, undefined);

await commands.get("policy").handler("why", ctx);
assert.ok(notices.some((n) => String(n.message).includes("workflow: strict")));

console.log("smoke-extension: OK");
