import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyTask } from "../src/core/classifier.js";
import { chooseWorkflow, modelPolicyId } from "../src/core/router.js";
import {
  composePolicies,
  loadProjectPolicies,
  renderPolicyBlock,
} from "../src/core/loader.js";
import { isApprovalPrompt } from "../src/core/approval.js";
import { mergeConfig } from "../src/core/config.js";
import { createRequire as _createRequire } from "node:module";
const require = _createRequire(import.meta.url);
import {
  appendHistory,
  clearHistory,
  defaultHistoryPath,
  readHistory,
  resolveHistoryPath,
} from "../src/core/history-store.js";
import {
  buildSemanticPrompt,
  buildSemanticRequestBody,
  maybeSemanticClassify,
} from "../src/core/semantic.js";
import {
  formatConfig,
  formatDiff,
  formatHistory,
  formatPreview,
  formatValidation,
} from "../extensions/policy-engine/format.js";
import {
  HISTORY_CAP,
  compareDecisions,
  preview,
  recordHistory,
  validateConfig,
} from "../extensions/policy-engine/state.js";
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

// v0.13 noise reduction: weak keywords need co-occurrence; strong hits fire alone.
{
  // Single weak term (组件) must NOT drag in frontend policy.
  const one = c("帮我看看这个业务组件的实现逻辑");
  assert.ok(!one.domains.includes("frontend"), `weak-only should not trigger: ${one.domains}`);
  assert.ok(one.reasons.some((r) => r.includes("domain:frontend dropped (weak-only")));

  // Two weak terms in the same domain = enough signal.
  const two = c("数据库和索引优化一下");
  assert.ok(two.domains.includes("database"), `2 weak should trigger: ${two.domains}`);

  // A single strong term fires immediately.
  const strong = c("postgres 的连接池怎么配");
  assert.ok(strong.domains.includes("database"));
}

// v0.13: domain count is capped (default 2), ranked by score.
{
  // Hits database + kubernetes + security strongly, plus backend weak×2.
  const x = c("postgres schema 迁移，k8s deployment 调整，还要加 jwt 鉴权，涉及后端接口和微服务");
  assert.ok(x.domains.length <= 2, `capped: ${x.domains}`);
  assert.ok(x.domains.includes("database")); // strongest (multiple strong hits)
  assert.ok(x.reasons.some((r) => r.includes("dropped (capped at 2")));
}

// v0.13: confidence reflects candidate dispersion.
{
  // Near-tie across task types → honest low confidence.
  const tie = c(
    "文档 docs markdown 里有个错误要定位，顺便架构拆分一下",
  );
  assert.ok(tie.confidence <= 0.75, `dispersed should be penalized: ${tie.confidence}`);
  assert.ok(tie.reasons.some((r) => r.startsWith("confidence penalized")));

  // Clear winner → stays high.
  const clear = c("修复这个 bug：接口报错 exception，定位到失败原因");
  assert.ok(clear.taskType === "debugging");
  assert.ok(clear.confidence >= 0.8, `clear winner should stay high: ${clear.confidence}`);
  assert.ok(!clear.reasons.some((r) => r.startsWith("confidence penalized")));
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

assert.equal(isApprovalPrompt("开始执行，按这个计划做"), true);
assert.equal(isApprovalPrompt("继续分析这个计划"), false);
assert.equal(isApprovalPrompt("不批准，先改计划"), false);
assert.equal(isApprovalPrompt("改一下 step 2 再执行"), false);

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
    { mode: "auto", profile: "auto", nested: { a: 1, b: 2 } },
    { mode: "strict", nested: { b: 99, c: 3 } },
    { includePolicies: ["behavior.execution-discipline"] },
  );
  assert.equal(merged.mode, "strict");
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

// preview() must return config so the /policy preview handler's
// historyFile append actually fires (v0.9 shipped the caller reading
// result.config?.historyFile but the field was missing — preview history
// never persisted).
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "preview config field regression test",
    model: null,
  });
  assert.ok(
    result.config && typeof result.config === "object",
    "preview() result must include the resolved config object",
  );
  assert.ok(
    typeof result.config.historyFile === "string",
    "result.config.historyFile must be reachable (defaults provide a string)",
  );
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
    throw new Error(
      `buildSemanticPrompt produced invalid JSON: ${error.message}`,
    );
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
    {
      taskType: "documentation",
      risk: "low",
      domains: [],
      analysisOnly: false,
      confidence: 0.5,
    },
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
    {
      taskType: "debugging",
      risk: "low",
      domains: [],
      analysisOnly: false,
      confidence: 0.95,
    },
    {
      semanticFallback: {
        enabled: true,
        endpoint: "https://x",
        model: "m",
        apiKeyEnvVar: "K",
      },
    },
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
    {
      taskType: "coding",
      risk: "low",
      domains: [],
      analysisOnly: false,
      confidence: 0.4,
    },
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
    {
      taskType: "coding",
      risk: "low",
      domains: [],
      analysisOnly: false,
      confidence: 0.4,
    },
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
  const fetcher = async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  });
  const merged = await maybeSemanticClassify(
    "x",
    {
      taskType: "coding",
      risk: "low",
      domains: [],
      analysisOnly: false,
      confidence: 0.4,
    },
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
      choices: [
        { message: { content: JSON.stringify({ taskType: "wrong" }) } },
      ],
    }),
  });
  const merged = await maybeSemanticClassify(
    "x",
    {
      taskType: "coding",
      risk: "low",
      domains: [],
      analysisOnly: false,
      confidence: 0.4,
    },
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

// preview: dry-run classification + composition without mutating state.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "修一个 PG migration bug，线上回滚",
    model: { provider: "minimax-cn", id: "MiniMax-M3" },
  });
  assert.ok(result.decision);
  assert.equal(result.decision.workflow, "strict");
  assert.ok(result.decision.domains.includes("database"));
  assert.ok(result.wouldRequireApproval);
  assert.ok(Array.isArray(result.policies));
  assert.ok(result.policies.some((p) => p.id === "core.evidence-priority"));
  assert.ok(result.policies.some((p) => p.id === "model.minimax-m3"));
  assert.ok(result.stats.builtInBytes > 0);
  assert.ok(result.stats.budget > 0);
  assert.ok(
    result.stats.budgetUsedPct >= 0 && result.stats.budgetUsedPct <= 100,
  );
}

// preview: pure read — does NOT mutate any shared state.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const before = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "low-risk readme typo",
    model: null,
  });
  const after = await preview({
    packageRoot: root,
    cwd: root,
    prompt: "high-risk 生产 PG schema 迁移",
    model: null,
  });
  assert.equal(before.decision.workflow, "quick");
  assert.equal(after.decision.workflow, "strict");
  // Two independent runs with different prompts, no shared mutation.
  assert.notEqual(before.decision.workflow, after.decision.workflow);
}

// formatPreview: stable, includes all key fields.
{
  const previewObj = {
    decision: {
      taskType: "architecture",
      risk: "high",
      confidence: 0.92,
      domains: ["database", "kubernetes"],
      workflow: "strict",
      profile: "architecture",
      modelPolicy: "model.minimax-m3",
    },
    classification: {
      reasons: ["risk:high matched prod", "task:architecture"],
    },
    policies: [{ id: "core.evidence-priority" }, { id: "domain.database" }],
    projectPolicies: [],
    truncated: ["domain.kubernetes"],
    wouldRequireApproval: true,
    stats: {
      builtInCount: 2,
      builtInBytes: 1024,
      projectCount: 0,
      projectBytes: 0,
      budget: 24000,
      budgetUsedPct: 4,
    },
  };
  const text = formatPreview(previewObj);
  assert.match(text, /# Policy preview/);
  assert.match(text, /workflow: strict/);
  assert.match(text, /would require approval: yes/);
  assert.match(text, /budget = 4%/);
  assert.match(text, /core\.evidence-priority/);
  assert.match(text, /truncated by byte budget:/);
  assert.match(text, /domain\.kubernetes/);
  assert.match(text, /classification reasons:/);
}

// formatPreview: null / empty input returns graceful message.
{
  assert.match(formatPreview(null), /No preview available/);
  const empty = formatPreview({
    decision: { workflow: "off" },
    classification: { reasons: [] },
    policies: [],
    projectPolicies: [],
    truncated: [],
    wouldRequireApproval: false,
    stats: {
      builtInCount: 0,
      builtInBytes: 0,
      projectCount: 0,
      projectBytes: 0,
      budget: 24000,
      budgetUsedPct: 0,
    },
  });
  assert.match(empty, /workflow: off/);
  assert.match(empty, /built-in policies \(0 loaded/);
}

// recordHistory: caps at HISTORY_CAP entries, drops oldest first.
{
  const state = { history: [] };
  const fakeDecision = {
    taskType: "coding",
    risk: "low",
    workflow: "quick",
    profile: "coding",
    confidence: 0.8,
  };
  for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
    recordHistory(state, {
      source: "decide",
      prompt: `prompt ${i}`,
      decision: fakeDecision,
    });
  }
  assert.equal(state.history.length, HISTORY_CAP);
  // Oldest 5 were dropped; the remaining entries are prompts 5..HISTORY_CAP+4.
  assert.match(state.history[0].prompt, /^prompt 5$/);
  assert.match(
    state.history[HISTORY_CAP - 1].prompt,
    new RegExp(`^prompt ${HISTORY_CAP + 4}$`),
  );
}

// recordHistory: trims long prompts to one line, ≤ 80 chars.
{
  const state = { history: [] };
  recordHistory(state, {
    source: "preview",
    prompt: "line1\nline2  line3   line4\n\n\n\nlong ".repeat(20),
    decision: {
      taskType: "coding",
      risk: "low",
      workflow: "quick",
      profile: "coding",
      confidence: 0.7,
    },
  });
  assert.equal(state.history.length, 1);
  assert.ok(state.history[0].prompt.length <= 80);
  assert.ok(!state.history[0].prompt.includes("\n"));
  assert.match(state.history[0].prompt, /\.\.\.$/);
}

// recordHistory: ignores missing decision (no throw, no entry).
{
  const state = { history: [] };
  recordHistory(state, { source: "decide", prompt: "x", decision: null });
  assert.equal(state.history.length, 0);
}

// compareDecisions: identical decisions produce empty diff.
{
  const decision = {
    workflow: "strict",
    taskType: "architecture",
    risk: "high",
    confidence: 0.9,
    domains: ["database"],
    profile: "architecture",
    modelPolicy: "model.minimax-m3",
    analysisOnly: false,
  };
  const preview = {
    decision,
    wouldRequireApproval: true,
  };
  assert.deepEqual(compareDecisions(preview, preview), []);
}

// compareDecisions: workflow + risk + confidence + domains differ.
{
  const left = {
    decision: {
      workflow: "strict",
      taskType: "architecture",
      risk: "high",
      confidence: 0.9,
      domains: ["database"],
      profile: "architecture",
      modelPolicy: null,
      analysisOnly: false,
    },
    wouldRequireApproval: true,
  };
  const right = {
    decision: {
      workflow: "quick",
      taskType: "documentation",
      risk: "low",
      confidence: 0.7,
      domains: [],
      profile: "coding",
      modelPolicy: null,
      analysisOnly: false,
    },
    wouldRequireApproval: false,
  };
  const diffs = compareDecisions(left, right);
  // workflow, task, risk, confidence, domains, profile, would require approval
  assert.ok(diffs.length >= 5);
  assert.ok(
    diffs.some(
      (d) =>
        d.field === "workflow" && d.left === "strict" && d.right === "quick",
    ),
  );
  assert.ok(
    diffs.some(
      (d) => d.field === "risk" && d.left === "high" && d.right === "low",
    ),
  );
}

// compareDecisions: domains with different order / content.
{
  const left = {
    decision: { domains: ["a", "b"] },
    wouldRequireApproval: false,
  };
  const right = {
    decision: { domains: ["b", "a"] },
    wouldRequireApproval: false,
  };
  // joined-comma comparison: "a,b" vs "b,a" -> differ
  assert.ok(compareDecisions(left, right).some((d) => d.field === "domains"));
}

// formatDiff: identical preview shows "no differences".
{
  const decision = {
    workflow: "quick",
    taskType: "coding",
    risk: "low",
    confidence: 0.85,
    domains: [],
    profile: "coding",
    modelPolicy: null,
    analysisOnly: false,
  };
  const preview = { decision, wouldRequireApproval: false };
  const text = formatDiff({
    leftPrompt: "fix typo",
    left: preview,
    rightPrompt: "fix typo 2",
    right: preview,
    differences: [],
  });
  assert.match(text, /# Policy diff/);
  assert.match(text, /fix typo/);
  assert.match(text, /both prompts route identically/);
}

// formatDiff: differences shown with arrow separator.
{
  const left = {
    decision: {
      workflow: "strict",
      taskType: "architecture",
      risk: "high",
      confidence: 0.9,
      domains: ["database"],
      profile: "architecture",
      modelPolicy: "model.minimax-m3",
      analysisOnly: false,
    },
    wouldRequireApproval: true,
  };
  const right = {
    decision: {
      workflow: "quick",
      taskType: "documentation",
      risk: "low",
      confidence: 0.7,
      domains: [],
      profile: "coding",
      modelPolicy: null,
      analysisOnly: false,
    },
    wouldRequireApproval: false,
  };
  const text = formatDiff({
    leftPrompt: "PG migration",
    left,
    rightPrompt: "fix typo",
    right,
    differences: compareDecisions(left, right),
  });
  assert.match(text, /LEFT/);
  assert.match(text, /RIGHT/);
  assert.match(text, /Differences \(\d+\)/);
  assert.match(text, /workflow: strict {2}→ {2}quick/);
  assert.match(text, /risk: high {2}→ {2}low/);
}

// validateConfig: clean baseline config returns ok with zero issues.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateConfig({
    config: {},
    packageRoot: root,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
}

// validateConfig: includePolicies with unknown id -> warning (not error).
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateConfig({
    config: { includePolicies: ["totally.bogus"] },
    packageRoot: root,
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.issues.some(
      (i) => i.severity === "warning" && i.message.includes("totally.bogus"),
    ),
  );
}

// validateConfig: core.* id is always accepted.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = validateConfig({
    config: { includePolicies: ["core.evidence-priority"] },
    packageRoot: root,
  });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
}

// validateConfig: missing manifest path -> error.
{
  // Temp fixtures go to the OS temp dir (mkdtemp), never the package root —
  // earlier revisions built them under <package>/.tmp-validate-* and leaked
  // on assertion failure.
  const fs = await import("node:fs/promises");
  const tmpDir = await fs.mkdtemp(join(tmpdir(), "pi-policy-validate-"));
  await fs.mkdir(join(tmpDir, "policies"), { recursive: true });
  await fs.writeFile(
    join(tmpDir, "policies", "manifest.json"),
    JSON.stringify({
      policies: { "ghost.policy": "policies/does-not-exist.md" },
    }),
  );
  const result = validateConfig({
    config: {},
    packageRoot: tmpDir,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (i) =>
        i.severity === "error" &&
        i.message.includes("ghost.policy") &&
        i.message.includes("does-not-exist.md"),
    ),
  );
  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
}

// validateConfig: profile referencing unknown id -> error.
{
  const fs = await import("node:fs/promises");
  const tmpDir2 = await fs.mkdtemp(join(tmpdir(), "pi-policy-validate-"));
  await fs.mkdir(join(tmpDir2, "profiles"), { recursive: true });
  await fs.writeFile(
    join(tmpDir2, "profiles", "broken.json"),
    JSON.stringify({ policies: ["missing.policy"] }),
  );
  const result = validateConfig({
    config: {},
    packageRoot: tmpDir2,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (i) =>
        i.severity === "error" &&
        i.message.includes("broken.json") &&
        i.message.includes("missing.policy"),
    ),
  );
  await fs.rm(tmpDir2, { recursive: true, force: true });
}

// formatValidation: ok with warnings.
{
  const text = formatValidation({
    ok: true,
    issues: [{ severity: "warning", message: "minor thing" }],
  });
  assert.match(text, /# Validation: OK \(with warnings\)/);
  assert.match(text, /Warnings \(1\)/);
  assert.match(text, /minor thing/);
}

// formatValidation: error.
{
  const text = formatValidation({
    ok: false,
    issues: [{ severity: "error", message: "broken thing" }],
  });
  assert.match(text, /# Validation: FAIL \(1 error\)/);
  assert.match(text, /Errors \(1\)/);
  assert.match(text, /broken thing/);
}

// formatValidation: no issues.
{
  const text = formatValidation({ ok: true, issues: [] });
  assert.match(text, /# Validation: OK/);
  assert.match(text, /No issues found/);
}

// formatValidation: pluralization.
{
  const text = formatValidation({
    ok: false,
    issues: [
      { severity: "error", message: "e1" },
      { severity: "error", message: "e2" },
    ],
  });
  assert.match(text, /FAIL \(2 errors\)/);
}

// history-store: resolveHistoryPath expands ~ and resolves relative paths.
{
  assert.match(resolveHistoryPath("~/x/y.jsonl"), /^~?\/.+x\/y\.jsonl$/);
  assert.match(resolveHistoryPath("/abs/path.jsonl"), /\/abs\/path\.jsonl$/);
  assert.equal(resolveHistoryPath(""), null);
  assert.equal(resolveHistoryPath(null), null);
  // cwd-relative
  assert.equal(
    resolveHistoryPath("rel.jsonl", "/tmp"),
    require("node:path").resolve("/tmp", "rel.jsonl"),
  );
  // default path
  const def = defaultHistoryPath();
  assert.match(def, /policy-engine\/history\.jsonl$/);
}

// history-store: round-trip via in-memory fs mock.
{
  // Minimal fs mock: appendFile accumulates, readFile returns contents.
  const store = new Map();
  const fs = {
    async appendFile(path, data) {
      store.set(path, (store.get(path) ?? "") + data);
    },
    async readFile(path) {
      if (!store.has(path)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return store.get(path);
    },
    async writeFile(path, data) {
      store.set(path, data);
    },
  };
  const file = "/mem/history.jsonl";

  // Empty file -> empty array.
  assert.deepEqual(await readHistory(file, 50, fs), []);

  // Append three entries.
  const entries = [
    { ts: 1, source: "decide", prompt: "p1", task: "coding" },
    { ts: 2, source: "preview", prompt: "p2", task: "debugging" },
    { ts: 3, source: "decide", prompt: "p3", task: "documentation" },
  ];
  for (const e of entries) {
    const r = await appendHistory(file, e, fs);
    assert.equal(r.ok, true);
  }
  assert.ok(store.get(file).split("\n").length === 4); // 3 + trailing empty

  // Read back: chronological order, respects limit.
  const got = await readHistory(file, 50, fs);
  assert.equal(got.length, 3);
  assert.equal(got[0].ts, 1);
  assert.equal(got[2].ts, 3);

  // Limit respected: only most-recent 2.
  const last2 = await readHistory(file, 2, fs);
  assert.equal(last2.length, 2);
  assert.equal(last2[0].ts, 2);
  assert.equal(last2[1].ts, 3);

  // Malformed line is skipped (graceful).
  store.set(file, store.get(file) + "{not-json\n");
  const withBad = await readHistory(file, 50, fs);
  assert.equal(withBad.length, 3);

  // Clear truncates.
  const cleared = await clearHistory(file, fs);
  assert.equal(cleared.ok, true);
  assert.equal(store.get(file), "");
  assert.deepEqual(await readHistory(file, 50, fs), []);
}

// history-store: appendHistory on write-failure returns ok:false.
{
  const fs = {
    async appendFile() {
      throw new Error("EACCES");
    },
  };
  const r = await appendHistory("/some/path", { ts: 1 }, fs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /EACCES/);
}

// history-store: readHistory on missing file returns [].
{
  const fs = {
    async readFile() {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
  };
  assert.deepEqual(await readHistory("/missing/path", 50, fs), []);
}

// formatConfig: minimal config shows all defaults.
{
  const text = formatConfig({});
  assert.match(text, /# Resolved policy-engine config/);
  assert.match(text, /mode: auto/);
  assert.match(text, /profile: auto/);
  assert.match(text, /showStatus: true/);
  assert.match(text, /projectPolicyMaxFiles: 12/);
  assert.match(text, /projectPolicyMaxBytes: 24000/);
  assert.match(text, /policyMaxBytes: 24000/);
  assert.match(text, /semanticFallback/);
  assert.match(text, /enabled: false/);
}

// formatConfig: real-world config with semantic fallback enabled.
{
  const text = formatConfig({
    mode: "strict",
    profile: "debugging",
    projectPolicyMaxFiles: 20,
    policyMaxBytes: 30000,
    domainHints: ["backend", "database"],
    includePolicies: ["behavior.execution-discipline"],
    semanticFallback: {
      enabled: true,
      endpoint: "https://api.example.test/v1/chat/completions",
      model: "test-model",
      apiKeyEnvVar: "TEST_KEY",
      confidenceThreshold: 0.6,
      timeoutMs: 5000,
    },
  });
  assert.match(text, /mode: strict/);
  assert.match(text, /profile: debugging/);
  assert.match(text, /projectPolicyMaxFiles: 20/);
  assert.match(text, /policyMaxBytes: 30000/);
  assert.match(text, /domainHints: \["backend","database"\]/);
  assert.match(text, /enabled: true/);
  assert.match(text, /endpoint: https:\/\/api\.example\.test/);
  assert.match(text, /confidenceThreshold: 0.6/);
  assert.match(text, /timeoutMs: 5000/);
}

// formatHistory: empty state shows graceful message.
{
  assert.match(formatHistory([], 5), /No routing history/);
  assert.match(formatHistory(null, 5), /No routing history/);
}

// formatHistory: respects N limit and renders rows in reverse-chronological
// order (newest first), with 1-based chronological numbering.
{
  const entries = [];
  for (let i = 0; i < 7; i += 1) {
    entries.push({
      ts: 1_700_000_000_000 + i * 60_000,
      source: "decide",
      prompt: `prompt ${i}`,
      task: "coding",
      risk: "low",
      workflow: "quick",
      profile: "coding",
      confidence: 0.8,
    });
  }
  const out = formatHistory(entries, 3);
  assert.match(out, /last 3 of 7/);
  // Most recent entry first.
  const newestIdx = out.indexOf("prompt 6");
  const midIdx = out.indexOf("prompt 5");
  const oldestIdx = out.indexOf("prompt 4");
  assert.ok(newestIdx > 0 && midIdx > 0 && oldestIdx > 0);
  assert.ok(newestIdx < midIdx);
  assert.ok(midIdx < oldestIdx);
  // Chronological numbering matches 1-based index of original entries.
  assert.match(out, /^7\./m);
  assert.match(out, /^5\./m);
}

// formatHistory: invalid N falls back to default 5.
{
  const entries = Array.from({ length: 3 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    source: "decide",
    prompt: `p ${i}`,
    task: "coding",
    risk: "low",
    workflow: "quick",
    profile: "coding",
    confidence: 0.8,
  }));
  const out = formatHistory(entries, NaN);
  assert.match(out, /last 3 of 3/);
}

process.stdout.write("self-test: OK\n");
