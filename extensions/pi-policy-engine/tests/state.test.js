// state.js / format.js / helpers.js / history-store.js tests:
// in-session state, formatting, command parsing, persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import {
  appendHistory,
  clearHistory,
  defaultHistoryPath,
  readHistory,
  resolveHistoryPath,
} from "../src/core/history-store.js";
import {
  HISTORY_CAP,
  compareDecisions,
  recordHistory,
} from "../extensions/policy-engine/state.js";
import { parsePolicyCommand } from "../extensions/policy-engine/helpers.js";
import {
  formatConfig,
  formatDiff,
  formatHistory,
  formatPreview,
  formatValidation,
} from "../extensions/policy-engine/format.js";

const fakeDecision = {
  taskType: "coding",
  risk: "low",
  rigor: "quick",
  profile: "coding",
  confidence: 0.8,
};

test("recordHistory caps at HISTORY_CAP, drops oldest", () => {
  const state = { history: [] };
  for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
    recordHistory(state, {
      source: "decide",
      prompt: `prompt ${i}`,
      decision: fakeDecision,
    });
  }
  assert.equal(state.history.length, HISTORY_CAP);
  assert.match(state.history[0].prompt, /^prompt 5$/);
  assert.match(
    state.history[HISTORY_CAP - 1].prompt,
    new RegExp(`^prompt ${HISTORY_CAP + 4}$`),
  );
});

test("recordHistory trims long prompts to one line ≤ 80 chars", () => {
  const state = { history: [] };
  recordHistory(state, {
    source: "preview",
    prompt: "line1\nline2  line3   line4\n\n\n\nlong ".repeat(20),
    decision: fakeDecision,
  });
  assert.equal(state.history.length, 1);
  assert.ok(state.history[0].prompt.length <= 80);
  assert.ok(!state.history[0].prompt.includes("\n"));
  assert.match(state.history[0].prompt, /\.\.\.$/);
});

test("recordHistory ignores missing decision", () => {
  const state = { history: [] };
  recordHistory(state, { source: "decide", prompt: "x", decision: null });
  assert.equal(state.history.length, 0);
});

test("compareDecisions: identical → empty diff", () => {
  const previewObj = {
    decision: {
      rigor: "strict",
      taskType: "architecture",
      risk: "high",
      confidence: 0.9,
      domains: ["database"],
      profile: "architecture",
      modelPolicy: "model.minimax-m3",
      executionIntent: "mutate",
    },
    wouldRequireApproval: true,
  };
  assert.deepEqual(compareDecisions(previewObj, previewObj), []);
});

test("compareDecisions: differing fields", () => {
  const left = {
    decision: {
      rigor: "strict",
      taskType: "architecture",
      risk: "high",
      confidence: 0.9,
      domains: ["database"],
      profile: "architecture",
      modelPolicy: null,
      executionIntent: "mutate",
    },
    wouldRequireApproval: true,
  };
  const right = {
    decision: {
      rigor: "quick",
      taskType: "documentation",
      risk: "low",
      confidence: 0.7,
      domains: [],
      profile: "coding",
      modelPolicy: null,
      executionIntent: "mutate",
    },
    wouldRequireApproval: false,
  };
  const diffs = compareDecisions(left, right);
  assert.ok(diffs.length >= 5);
  assert.ok(
    diffs.some(
      (d) => d.field === "rigor" && d.left === "strict" && d.right === "quick",
    ),
  );
  assert.ok(
    diffs.some(
      (d) => d.field === "risk" && d.left === "high" && d.right === "low",
    ),
  );
});

test("compareDecisions: domain order matters (joined comparison)", () => {
  const left = {
    decision: { domains: ["a", "b"] },
    wouldRequireApproval: false,
  };
  const right = {
    decision: { domains: ["b", "a"] },
    wouldRequireApproval: false,
  };
  assert.ok(compareDecisions(left, right).some((d) => d.field === "domains"));
});

test("formatDiff: no differences message", () => {
  const previewObj = {
    decision: {
      rigor: "quick",
      taskType: "coding",
      risk: "low",
      confidence: 0.85,
      domains: [],
      profile: "coding",
      modelPolicy: null,
      executionIntent: "mutate",
    },
    wouldRequireApproval: false,
  };
  const text = formatDiff({
    leftPrompt: "fix typo",
    left: previewObj,
    rightPrompt: "fix typo 2",
    right: previewObj,
    differences: [],
  });
  assert.match(text, /# Policy diff/);
  assert.match(text, /fix typo/);
  assert.match(text, /both prompts route identically/);
});

test("formatDiff: differences with arrow separator", () => {
  const left = {
    decision: {
      rigor: "strict",
      taskType: "architecture",
      risk: "high",
      confidence: 0.9,
      domains: ["database"],
      profile: "architecture",
      modelPolicy: "model.minimax-m3",
      executionIntent: "mutate",
    },
    wouldRequireApproval: true,
  };
  const right = {
    decision: {
      rigor: "quick",
      taskType: "documentation",
      risk: "low",
      confidence: 0.7,
      domains: [],
      profile: "coding",
      modelPolicy: null,
      executionIntent: "mutate",
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
  assert.match(text, /rigor: strict {2}→ {2}quick/);
  assert.match(text, /risk: high {2}→ {2}low/);
});

test("formatPreview: stable rendering with all key fields", () => {
  const text = formatPreview({
    decision: {
      taskType: "architecture",
      risk: "high",
      confidence: 0.92,
      domains: ["database", "kubernetes"],
      rigor: "strict",
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
  });
  assert.match(text, /# Policy preview/);
  assert.match(text, /rigor: strict/);
  assert.match(text, /would require approval: yes/);
  assert.match(text, /total budget = 4%/);
  assert.match(text, /core\.evidence-priority/);
  assert.match(text, /truncated by byte budget:/);
  assert.match(text, /domain\.kubernetes/);
  assert.match(text, /classification reasons:/);
});

test("formatPreview: null and empty inputs", () => {
  assert.match(formatPreview(null), /No preview available/);
  const empty = formatPreview({
    decision: { rigor: "off" },
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
  assert.match(empty, /rigor: off/);
  assert.match(empty, /built-in 0 \+ project 0/);
});

test("formatConfig: defaults and real-world config", () => {
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

  const rich = formatConfig({
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
  assert.match(rich, /mode: strict/);
  assert.match(rich, /profile: debugging/);
  assert.match(rich, /enabled: true/);
  assert.match(rich, /confidenceThreshold: 0.6/);
});

test("formatHistory: empty, limit, ordering, numbering", () => {
  assert.match(formatHistory([], 5), /No routing history/);
  assert.match(formatHistory(null, 5), /No routing history/);

  const entries = Array.from({ length: 7 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 60_000,
    source: "decide",
    prompt: `prompt ${i}`,
    task: "coding",
    risk: "low",
    rigor: "quick",
    profile: "coding",
    confidence: 0.8,
  }));
  const out = formatHistory(entries, 3);
  assert.match(out, /last 3 of 7/);
  const newestIdx = out.indexOf("prompt 6");
  const midIdx = out.indexOf("prompt 5");
  const oldestIdx = out.indexOf("prompt 4");
  assert.ok(newestIdx > 0 && midIdx > newestIdx && oldestIdx > midIdx);
  assert.match(out, /^7\./m);
  assert.match(out, /^5\./m);

  const fallback = formatHistory(
    entries.slice(0, 3).map((e, i) => ({ ...e, prompt: `p ${i}` })),
    NaN,
  );
  assert.match(fallback, /last 3 of 3/);
});

test("formatValidation: ok / warnings / errors / pluralization", () => {
  assert.match(formatValidation({ ok: true, issues: [] }), /# Validation: OK/);
  assert.match(formatValidation({ ok: true, issues: [] }), /No issues found/);
  const warn = formatValidation({
    ok: true,
    issues: [{ severity: "warning", message: "minor thing" }],
  });
  assert.match(warn, /# Validation: OK \(with warnings\)/);
  assert.match(warn, /Warnings \(1\)/);
  const err = formatValidation({
    ok: false,
    issues: [{ severity: "error", message: "broken thing" }],
  });
  assert.match(err, /# Validation: FAIL \(1 error\)/);
  const two = formatValidation({
    ok: false,
    issues: [
      { severity: "error", message: "e1" },
      { severity: "error", message: "e2" },
    ],
  });
  assert.match(two, /FAIL \(2 errors\)/);
});

test("parsePolicyCommand", () => {
  const a = parsePolicyCommand("strict");
  assert.equal(a.action, "strict");
  assert.deepEqual(a.rest, []);
  const b = parsePolicyCommand("  once quick  ");
  assert.equal(b.action, "once");
  assert.deepEqual(b.rest, ["quick"]);
  const c = parsePolicyCommand("   ");
  assert.equal(c.action, "status");
  assert.deepEqual(c.rest, []);
});

test("history-store: resolveHistoryPath", () => {
  assert.match(resolveHistoryPath("~/x/y.jsonl"), /^~?\/.+x\/y\.jsonl$/);
  assert.match(resolveHistoryPath("/abs/path.jsonl"), /\/abs\/path\.jsonl$/);
  assert.equal(resolveHistoryPath(""), null);
  assert.equal(resolveHistoryPath(null), null);
  assert.equal(
    resolveHistoryPath("rel.jsonl", "/tmp"),
    require("node:path").resolve("/tmp", "rel.jsonl"),
  );
  assert.match(defaultHistoryPath(), /policy-engine\/history\.jsonl$/);
});

test("history-store: round-trip via in-memory fs mock", async () => {
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

  assert.deepEqual(await readHistory(file, 50, fs), []);

  const entries = [
    { ts: 1, source: "decide", prompt: "p1", task: "coding" },
    { ts: 2, source: "preview", prompt: "p2", task: "debugging" },
    { ts: 3, source: "decide", prompt: "p3", task: "documentation" },
  ];
  for (const e of entries) {
    assert.equal((await appendHistory(file, e, fs)).ok, true);
  }
  assert.equal(store.get(file).split("\n").length, 4);

  const got = await readHistory(file, 50, fs);
  assert.equal(got.length, 3);
  assert.equal(got[0].ts, 1);
  assert.equal(got[2].ts, 3);

  const last2 = await readHistory(file, 2, fs);
  assert.equal(last2.length, 2);
  assert.equal(last2[0].ts, 2);

  store.set(file, store.get(file) + "{not-json\n");
  assert.equal((await readHistory(file, 50, fs)).length, 3);

  assert.equal((await clearHistory(file, fs)).ok, true);
  assert.equal(store.get(file), "");
  assert.deepEqual(await readHistory(file, 50, fs), []);
});

test("history-store: write failure returns ok:false", async () => {
  const fs = {
    async appendFile() {
      throw new Error("EACCES");
    },
  };
  const r = await appendHistory("/some/path", { ts: 1 }, fs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /EACCES/);
});

test("history-store: missing file reads as []", async () => {
  const fs = {
    async readFile() {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
  };
  assert.deepEqual(await readHistory("/missing/path", 50, fs), []);
});

test("history-store: disk rotation compacts oversized files", async () => {
  let stored = "";
  const big = "x".repeat(600); // 600+ bytes per line → 1000 lines > 512 KB
  const fs = {
    async stat() {
      return { size: ROTATE_THRESHOLD + 1 };
    },
    async readFile() {
      return stored;
    },
    async writeFile(_p, data) {
      stored = data;
    },
    async appendFile(_p, data) {
      stored += data;
    },
  };
  const { appendHistory, ROTATE_THRESHOLD } = await import(
    "../src/core/history-store.js"
  );
  // Build an oversized file: 1002 entries via direct writes.
  const entries = Array.from({ length: 1002 }, (_, i) =>
    JSON.stringify({ ts: i, source: "decide", prompt: `${big}-${i}` }),
  );
  stored = entries.join("\n") + "\n";
  // Next append triggers rotation (stat > threshold): keep last 1000 lines.
  const r = await appendHistory("/mem/hist.jsonl", { ts: 9999 }, fs);
  assert.equal(r.ok, true);
  const lines = stored.split("\n").filter(Boolean);
  assert.ok(
    lines.length <= 1002,
    `rotated file should be compact (got ${lines.length})`,
  );
  assert.ok(
    lines.length >= 1000,
    `rotation keeps the most recent entries (got ${lines.length})`,
  );
  assert.equal(JSON.parse(lines[lines.length - 1]).ts, 9999);
});
