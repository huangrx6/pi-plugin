import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTask } from "../src/core/classifier.js";
import { chooseWorkflow, modelPolicyId } from "../src/core/router.js";
import {
  composePolicies,
  loadProjectPolicies,
  renderPolicyBlock,
} from "../src/core/loader.js";
import {
  findMutatingShell,
  isApprovalPrompt,
  isMutatingShell,
  shouldBlockTool,
  splitShellSegments,
} from "../src/core/guard.js";
import { mergeConfig } from "../src/core/config.js";
import {
  buildSemanticPrompt,
  buildSemanticRequestBody,
  maybeSemanticClassify,
} from "../src/core/semantic.js";
import { parsePolicyCommand } from "../extensions/policy-engine/helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let routing;
try {
  routing = JSON.parse(
    readFileSync(join(root, "config", "routing.json"), "utf8"),
  );
} catch (error) {
  throw new Error(`failed to load config/routing.json: ${error.message}`);
}

function c(prompt) {
  return classifyTask(prompt, routing, []);
}

{
  const x = c("帮我只改 README 里的一处 Tab 补全描述");
  assert.equal(x.taskType, "documentation");
  assert.equal(x.risk, "low");
  assert.equal(chooseWorkflow(x, "auto"), "quick");
}

{
  const x = c("这个接口最近偶尔返回旧数据，帮我排查 bug 并修复");
  assert.equal(x.taskType, "debugging");
  assert.equal(chooseWorkflow(x, "auto"), "standard");
}

{
  const x = c("设计 PostgreSQL 数据库迁移方案，线上不能停机，需要回滚");
  assert.equal(x.taskType, "architecture");
  assert.equal(x.risk, "high");
  assert.equal(chooseWorkflow(x, "auto"), "strict");
  assert.ok(x.domains.includes("database"));
}

{
  const x = c("k8s deployment 的 hostPath 挂载需要调整，生产环境不能停机");
  assert.equal(x.risk, "high");
  assert.ok(x.domains.includes("kubernetes"));
  assert.equal(chooseWorkflow(x, "auto"), "strict");
}

{
  const x = c("只分析这个数据库迁移方案，不要修改任何文件");
  assert.equal(x.analysisOnly, true);
  assert.equal(chooseWorkflow(x, "auto"), "standard");
}

assert.equal(
  modelPolicyId({ provider: "minimax-cn", id: "MiniMax-M3" }),
  "model.minimax-m3",
);
assert.equal(
  modelPolicyId({ provider: "deepseek", id: "deepseek-v4" }),
  "model.deepseek",
);
assert.equal(modelPolicyId({ provider: "foo", id: "bar" }), null);

assert.equal(isMutatingShell("git status"), false);
assert.equal(isMutatingShell("rg TODO src"), false);
assert.equal(isMutatingShell("git commit -am test"), true);
assert.equal(isMutatingShell("kubectl apply -f deploy.yaml"), true);
assert.equal(isMutatingShell("echo hello > file.txt"), true);
assert.equal(isApprovalPrompt("开始执行，按这个计划做"), true);
assert.equal(isApprovalPrompt("继续分析这个计划"), false);

{
  const x = shouldBlockTool({ toolName: "edit", input: {} }, "soft", true);
  assert.equal(x.block, true);
}
{
  const x = shouldBlockTool(
    { toolName: "bash", input: { command: "git status" } },
    "hard",
    true,
  );
  assert.equal(x.block, false);
}
{
  const x = shouldBlockTool(
    { toolName: "bash", input: { command: "rm -rf tmp" } },
    "hard",
    true,
  );
  assert.equal(x.block, true);
}
{
  const x = shouldBlockTool(
    { toolName: "bash", input: { command: "rm -rf tmp" } },
    "soft",
    true,
  );
  assert.equal(x.block, false);
}

{
  const projectPolicies = loadProjectPolicies(
    join(root, "examples", "project"),
    {
      projectPolicyMaxFiles: 12,
      projectPolicyMaxBytes: 24000,
    },
  );
  assert.equal(projectPolicies.length, 2);
  assert.match(projectPolicies[0].content, /backward compatible/i);
  assert.match(projectPolicies[1].content, /observability/i);
}

// mergeConfig: deep merge of nested objects.
{
  const merged = mergeConfig(
    { gate: "soft", profile: "auto", nested: { a: 1, b: 2 } },
    { gate: "hard", nested: { b: 99, c: 3 } },
    { includePolicies: ["behavior.execution-discipline"] },
  );
  assert.equal(merged.gate, "hard");
  assert.equal(merged.profile, "auto");
  assert.deepEqual(merged.nested, { a: 1, b: 99, c: 3 });
}

// mergeConfig: arrays of objects with `id` are unioned (deduped by id).
{
  const merged = mergeConfig(
    {
      items: [
        { id: "x", v: 1 },
        { id: "y", v: 2 },
      ],
    },
    {
      items: [
        { id: "y", v: 22 },
        { id: "z", v: 3 },
      ],
    },
  );
  assert.equal(merged.items.length, 3);
  const xs = merged.items.map((i) => i.id);
  assert.deepEqual(xs, ["x", "y", "z"]);
  assert.equal(merged.items.find((i) => i.id === "y").v, 22);
}

// Categorized shell guard: findMutatingShell returns category+label.
{
  const rm = findMutatingShell("rm -rf tmp");
  assert.equal(rm.category, "file");
  assert.equal(rm.label, "rm");
  const git = findMutatingShell("git push origin main");
  assert.equal(git.category, "git");
  const kubectl = findMutatingShell("kubectl apply -f x.yaml");
  assert.equal(kubectl.category, "k8s");
  assert.equal(findMutatingShell("git status"), null);
}

// Per-category enable/disable via config.guard.
{
  const git = findMutatingShell("git commit -m x");
  assert.equal(git.category, "git");
  // hard gate with k8s disabled
  const blocked = shouldBlockTool(
    { toolName: "bash", input: { command: "kubectl apply -f x" } },
    "hard",
    true,
    { disabledCategories: ["k8s"] },
  );
  assert.equal(blocked.block, false);
  const blockedFile = shouldBlockTool(
    { toolName: "bash", input: { command: "rm -rf tmp" } },
    "hard",
    true,
    { disabledCategories: ["k8s"] },
  );
  assert.equal(blockedFile.block, true);
  assert.match(blockedFile.reason, /file: rm/);
}

// Byte budget: composePolicies drops low-priority policies when over budget.
{
  const decision = {
    taskType: "coding",
    risk: "high",
    confidence: 0.9,
    analysisOnly: false,
    domains: ["database", "kubernetes"],
    workflow: "strict",
    profile: "coding",
    modelPolicy: "model.minimax-m3",
    gate: "soft",
    reasons: [],
  };
  const tight = composePolicies({
    packageRoot: root,
    decision,
    config: { policyMaxBytes: 1500, excludePolicies: [], includePolicies: [] },
    phase: "planning",
  });
  assert.ok(
    tight.truncated.length > 0,
    "expected some policies to be truncated under tight budget",
  );
  // project-domain.kubernetes should drop before core.* does.
  assert.ok(!tight.policies.some((p) => p.id === "domain.kubernetes"));
  assert.ok(tight.policies.some((p) => p.id === "core.evidence-priority"));
}

// renderPolicyBlock surfaces truncated list.
{
  const decision = {
    taskType: "coding",
    risk: "low",
    confidence: 0.9,
    analysisOnly: false,
    domains: [],
    workflow: "quick",
    profile: "coding",
    modelPolicy: null,
    gate: "soft",
    reasons: [],
  };
  const block = renderPolicyBlock({
    decision,
    policies: [],
    projectPolicies: [],
    phase: "executing",
    truncated: ["domain.database", "model.minimax-m3"],
  });
  assert.match(block, /domain\.database/);
  assert.match(block, /model\.minimax-m3/);
  assert.match(block, /byte budget/i);
}

// Command parsing.
{
  const a = parsePolicyCommand("strict");
  assert.equal(a.action, "strict");
  assert.deepEqual(a.rest, []);
  const b = parsePolicyCommand("  once quick  ");
  assert.equal(b.action, "once");
  assert.deepEqual(b.rest, ["quick"]);
  const c = parsePolicyCommand("   ");
  assert.equal(c.action, "status");
  assert.deepEqual(c.rest, []);
}

// Structured shell parsing: splitShellSegments respects quotes and $().
{
  // Basic splitter
  assert.deepEqual(splitShellSegments("ls && rm tmp"), ["ls", "rm tmp"]);
  assert.deepEqual(splitShellSegments("a; b; c"), ["a", "b", "c"]);
  assert.deepEqual(splitShellSegments("a || b"), ["a", "b"]);
  // Pipes are split too (both sides can mutate independently).
  assert.deepEqual(splitShellSegments("echo hi | sed -i s/x/y/"), [
    "echo hi",
    "sed -i s/x/y/",
  ]);
  // Quoted splitter characters do NOT split.
  assert.deepEqual(splitShellSegments('echo "a && b"'), ['echo "a && b"']);
  assert.deepEqual(splitShellSegments("echo 'rm -rf /'"), ["echo 'rm -rf /'"]);
  // $(...) is opaque — splitter inside the substitution is not honored.
  assert.deepEqual(splitShellSegments("echo $(rm -rf /tmp)"), [
    "echo $(rm -rf /tmp)",
  ]);
  // Empty / whitespace-only inputs.
  assert.deepEqual(splitShellSegments(""), []);
  assert.deepEqual(splitShellSegments("   "), []);
  assert.deepEqual(splitShellSegments(";"), []);
}

// Structured parsing should classify correctly even with quotes and pipes.
{
  // Quoted rm is NOT mutating.
  assert.equal(findMutatingShell('echo "rm -rf /" | grep warn'), null);
  // Unquoted rm IS mutating.
  const r = findMutatingShell("echo hi; rm -rf tmp");
  assert.equal(r?.category, "file");
  assert.equal(r?.label, "rm");
  assert.match(r?.segment ?? "", /^rm /);
  // kubectl apply at the head of a multi-segment command.
  const k = findMutatingShell("kubectl apply -f x.yaml && sleep 5");
  assert.equal(k?.category, "k8s");
  assert.match(k?.segment ?? "", /^kubectl /);
  // Nested mutating inside $() — we DO classify this (it's still a deletion).
  const s = findMutatingShell("echo $(rm -rf /etc/foo)");
  assert.equal(s?.category, "file");
  // last segment wins if earlier ones are clean.
  assert.equal(
    findMutatingShell("git status; sleep 1; kubectl delete pod x")?.label,
    "kubectl apply|delete|patch|...",
  );
}

// shouldBlockTool reason should include the offending segment (v0.3).
{
  const r = shouldBlockTool(
    { toolName: "bash", input: { command: "echo hi && rm -rf /tmp" } },
    "hard",
    true,
  );
  assert.equal(r.block, true);
  assert.match(r.reason, /file: rm/);
  assert.match(r.reason, /rm -rf \/tmp/);
}

// Semantic fallback: pure helpers.
{
  const body = buildSemanticRequestBody(
    "gpt-4o-mini",
    '{"prompt":"x","deterministic":{"taskType":"coding"}}',
  );
  assert.equal(body.model, "gpt-4o-mini");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[1].content, /deterministic/);
  const userPayload = buildSemanticPrompt("hi", {
    taskType: "coding",
    risk: "low",
    domains: [],
    analysisOnly: false,
    confidence: 0.6,
    reasons: [],
  });
  let parsed;
  try {
    parsed = JSON.parse(userPayload);
  } catch (error) {
    throw new Error(`buildSemanticPrompt produced invalid JSON: ${error.message}`);
  }
  assert.equal(parsed.prompt, "hi");
  assert.equal(parsed.deterministic.taskType, "coding");
}

// Semantic fallback: disabled by default — never makes a network call.
{
  const calls = [];
  const fetcher = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, json: () => ({}) });
  };
  const result = await maybeSemanticClassify(
    "修个 typo",
    { taskType: "documentation", risk: "low", domains: [], analysisOnly: false, confidence: 0.5 },
    { semanticFallback: { enabled: false } },
    { fetcher },
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
}

// Semantic fallback: enabled but confidence is high — not invoked.
{
  const calls = [];
  const fetcher = () => {
    calls.push(1);
    return Promise.resolve({ ok: true });
  };
  const result = await maybeSemanticClassify(
    "fix a bug",
    { taskType: "debugging", risk: "low", domains: [], analysisOnly: false, confidence: 0.95 },
    { semanticFallback: { enabled: true, endpoint: "https://x", model: "m", apiKeyEnvVar: "K" } },
    { fetcher },
  );
  assert.equal(result, null);
  assert.equal(calls.length, 0);
}

// Semantic fallback: low confidence + enabled + stub fetcher — parses response.
{
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  let lastBody;
  const fetcher = async (_url, init) => {
    try {
      lastBody = JSON.parse(init.body);
    } catch (error) {
      throw new Error(`fetcher received invalid JSON body: ${error.message}`);
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                taskType: "architecture",
                risk: "high",
                domains: ["database", "kubernetes"],
                analysisOnly: false,
                confidence: 0.9,
              }),
            },
          },
        ],
      }),
    };
  };
  const merged = await maybeSemanticClassify(
    "我们线上 deploy 经常回滚，schema 也跟不上",
    {
      taskType: "coding",
      risk: "medium",
      domains: [],
      analysisOnly: false,
      confidence: 0.5,
      reasons: ["task:coding matched ..."],
    },
    {
      semanticFallback: {
        enabled: true,
        endpoint: "https://example.test/v1/chat/completions",
        model: "test-model",
        apiKeyEnvVar: "PI_POLICY_TEST_KEY",
        confidenceThreshold: 0.7,
      },
    },
    { fetcher },
  );
  assert.ok(merged);
  assert.equal(merged.taskType, "architecture");
  assert.equal(merged.risk, "high");
  assert.deepEqual(merged.domains, ["database", "kubernetes"]);
  assert.equal(merged.analysisOnly, false);
  assert.equal(merged.confidence, 0.9);
  assert.ok(merged.reasons.some((r) => r.startsWith("semantic-fallback:")));
  assert.equal(lastBody.model, "test-model");
  assert.equal(lastBody.temperature, 0);
  assert.equal(lastBody.response_format.type, "json_object");
  delete process.env.PI_POLICY_TEST_KEY;
}

// Semantic fallback: fetcher throws — returns null (deterministic stands).
{
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const fetcher = async () => {
    throw new Error("network down");
  };
  const merged = await maybeSemanticClassify(
    "x",
    { taskType: "coding", risk: "low", domains: [], analysisOnly: false, confidence: 0.4 },
    {
      semanticFallback: {
        enabled: true,
        endpoint: "https://example.test",
        model: "m",
        apiKeyEnvVar: "PI_POLICY_TEST_KEY",
      },
    },
    { fetcher },
  );
  assert.equal(merged, null);
  delete process.env.PI_POLICY_TEST_KEY;
}

// Semantic fallback: missing API key — returns null.
{
  delete process.env.PI_POLICY_TEST_KEY;
  const merged = await maybeSemanticClassify(
    "x",
    { taskType: "coding", risk: "low", domains: [], analysisOnly: false, confidence: 0.4 },
    {
      semanticFallback: {
        enabled: true,
        endpoint: "https://example.test",
        model: "m",
        apiKeyEnvVar: "PI_POLICY_TEST_KEY",
      },
    },
  );
  assert.equal(merged, null);
}

// Semantic fallback: response not ok — returns null.
{
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const fetcher = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const merged = await maybeSemanticClassify(
    "x",
    { taskType: "coding", risk: "low", domains: [], analysisOnly: false, confidence: 0.4 },
    {
      semanticFallback: {
        enabled: true,
        endpoint: "https://example.test",
        model: "m",
        apiKeyEnvVar: "PI_POLICY_TEST_KEY",
      },
    },
    { fetcher },
  );
  assert.equal(merged, null);
  delete process.env.PI_POLICY_TEST_KEY;
}

// Semantic fallback: response schema invalid — returns null.
{
  process.env.PI_POLICY_TEST_KEY = "sk-test";
  const fetcher = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ taskType: "wrong" }) } }],
    }),
  });
  const merged = await maybeSemanticClassify(
    "x",
    { taskType: "coding", risk: "low", domains: [], analysisOnly: false, confidence: 0.4 },
    {
      semanticFallback: {
        enabled: true,
        endpoint: "https://example.test",
        model: "m",
        apiKeyEnvVar: "PI_POLICY_TEST_KEY",
      },
    },
    { fetcher },
  );
  assert.equal(merged, null);
  delete process.env.PI_POLICY_TEST_KEY;
}

process.stdout.write("self-test: OK\n");
