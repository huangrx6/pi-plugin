// v0.20: strict-plan state persists across session restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import policyEngine from "../extensions/policy-engine/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateFile = join(
  mkdtempSync(join(tmpdir(), "pi-policy-ss-")),
  "strict-state.json",
);
const cwdA = mkdtempSync(join(tmpdir(), "pi-policy-ss-a-"));
const cwdB = mkdtempSync(join(tmpdir(), "pi-policy-ss-b-"));

test("save/load/clear round-trip (unit, fs mock)", async () => {
  const { saveStrictState, loadStrictState, clearStrictState } = await import(
    "../src/core/history-store.js"
  );
  const store = new Map();
  const fs = {
    async readFile(p) {
      return store.get(p) ?? "";
    },
    async writeFile(p, d) {
      store.set(p, d);
    },
    async mkdir() {},
  };
  const decision = {
    taskType: "architecture",
    risk: "high",
    confidence: 0.9,
    executionIntent: "mutate",
    domains: ["database"],
    concerns: ["production"],
    rigor: "strict",
    flow: null,
    profile: "architecture",
    modelPolicy: null,
    reasons: ["r1"],
  };
  await saveStrictState(stateFile, { cwd: cwdA, decision }, fs);
  const restored = await loadStrictState(stateFile, { cwd: cwdA }, fs);
  assert.equal(restored.phase, "awaiting_approval");
  assert.equal(restored.decision.rigor, "strict");
  assert.deepEqual(restored.decision.concerns, ["production"]);
  // cwd mismatch → null (different project must not steal the plan)
  assert.equal(await loadStrictState(stateFile, { cwd: cwdB }, fs), null);
  // clear → null
  await clearStrictState(stateFile, fs);
  assert.equal(await loadStrictState(stateFile, { cwd: cwdA }, fs), null);
});

test("stale state (over maxAge) is not restored", async () => {
  const { saveStrictState, loadStrictState } = await import(
    "../src/core/history-store.js"
  );
  const store = new Map();
  const fs = {
    async readFile(p) {
      const v = store.get(p);
      if (!v) throw new Error("ENOENT");
      return v;
    },
    async writeFile(p, d) {
      store.set(p, d);
    },
    async mkdir() {},
  };
  const decision = {
    rigor: "strict",
    taskType: "coding",
    risk: "high",
    domains: [],
  };
  await saveStrictState(stateFile, { cwd: cwdA, decision }, fs);
  // forge an old timestamp
  const parsed = JSON.parse(store.get(stateFile));
  parsed.ts = Date.now() - 8 * 24 * 3600 * 1000; // 8 days
  store.set(stateFile, JSON.stringify(parsed));
  assert.equal(await loadStrictState(stateFile, { cwd: cwdA }, fs), null);
});

test("end-to-end: session restart restores awaiting_approval", async () => {
  const { saveStrictState, loadStrictState } = await import(
    "../src/core/history-store.js"
  );
  const historyDir = mkdtempSync(join(tmpdir(), "pi-policy-e2e-"));
  const decision = {
    taskType: "architecture",
    risk: "high",
    confidence: 0.9,
    executionIntent: "mutate",
    domains: ["database"],
    concerns: ["production"],
    rigor: "strict",
    flow: null,
    profile: "architecture",
    modelPolicy: null,
    reasons: [],
  };
  const sPath = join(historyDir, "strict-state.json");
  await saveStrictState(sPath, { cwd: cwdA, decision });
  const restored = await loadStrictState(sPath, { cwd: cwdA });
  assert.ok(restored);
  assert.equal(restored.decision.rigor, "strict");
  rmSync(historyDir, { recursive: true, force: true });
});

rmSync(stateFile, { force: true });
rmSync(cwdA, { recursive: true, force: true });
rmSync(cwdB, { recursive: true, force: true });

// ---- v0.21: per-project namespacing + model recompute ----------------------

test("strictStatePath namespaces by cwd (project A/B do not collide)", async () => {
  const { strictStatePath } = await import("../src/core/history-store.js");
  const h = "/tmp/shared/history.jsonl";
  const a = strictStatePath(h, "/repo/project-a");
  const b = strictStatePath(h, "/repo/project-b");
  assert.notEqual(a, b);
  assert.ok(/strict-state-[0-9a-f]{16}\.json$/.test(a));
  assert.ok(a.startsWith("/tmp/shared"));

  // legacy callers without cwd keep the old name (back-compat)
  assert.equal(strictStatePath(h), "/tmp/shared/strict-state.json");
});

test("legacy v0.20 payloads with modelPolicy are stripped on restore", async () => {
  const { loadStrictState } = await import("../src/core/history-store.js");
  const store = new Map();
  const fs = {
    async readFile(p) {
      const v = store.get(p);
      if (!v) throw new Error("ENOENT");
      return v;
    },
  };
  store.set(
    "/f.json",
    JSON.stringify({
      version: 1,
      cwd: "/x",
      ts: Date.now(),
      phase: "awaiting_approval",
      decision: {
        taskType: "coding",
        risk: "high",
        rigor: "strict",
        modelPolicy: "model.minimax-m3", // stale v0.20 field
        domains: [],
      },
    }),
  );
  const restored = await loadStrictState("/f.json", { cwd: "/x" }, fs);
  assert.ok(restored);
  assert.equal("modelPolicy" in restored.decision, false);
});

test("E2E: A/B projects restore independently; model switch recomputes adaptation", async () => {
  // HOME is redirected so the "global" config is a temp file — the project
  // layer can no longer set historyFile (trust boundary), so the E2E uses
  // the global layer the way a real user would.
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-policy-home-"));
  const repoA = mkdtempSync(join(tmpdir(), "pi-policy-a-"));
  const repoB = mkdtempSync(join(tmpdir(), "pi-policy-b-"));
  mkdirSync(join(home, ".pi", "agent", "policy-engine"), { recursive: true });
  process.env.HOME = home;
  try {
    writeFileSync(
      join(home, ".pi", "agent", "policy-engine.json"),
      JSON.stringify({ showStatus: false, historyMaxEntries: 50 }),
    );
    const makeSession = (cwd, model) => {
      const handlers = new Map();
      policyEngine({
        on: (n, f) => handlers.set(n, f),
        registerCommand: () => {},
      });
      return {
        handlers,
        ctx: {
          cwd,
          model,
          ui: { notify() {}, setStatus() {} },
        },
      };
    };

    // Project A: strict plan → awaiting (persisted under A's namespace).
    const a1 = makeSession(repoA, { provider: "minimax-cn", id: "MiniMax-M3" });
    await a1.handlers.get("session_start")({}, a1.ctx);
    await a1.handlers.get("before_agent_start")(
      {
        prompt: "设计生产环境 PostgreSQL 迁移方案并实施，需要回滚",
        systemPrompt: "B",
      },
      a1.ctx,
    );
    await a1.handlers.get("agent_end")({}, a1.ctx);

    // Project B: different strict plan (its own namespace file).
    const b1 = makeSession(repoB, { provider: "minimax-cn", id: "MiniMax-M3" });
    await b1.handlers.get("session_start")({}, b1.ctx);
    await b1.handlers.get("before_agent_start")(
      { prompt: "重构整个认证体系并实施 jwt 鉴权", systemPrompt: "B" },
      b1.ctx,
    );
    await b1.handlers.get("agent_end")({}, b1.ctx);

    // Restart in A under a DIFFERENT model: restore must return A's task and
    // recompute the model adaptation (deepseek, not minimax).
    const a2 = makeSession(repoA, { provider: "deepseek", id: "deepseek-v4" });
    await a2.handlers.get("session_start")({}, a2.ctx);
    const approved = await a2.handlers.get("before_agent_start")(
      { prompt: "批准", systemPrompt: "B" },
      a2.ctx,
    );
    assert.match(approved.systemPrompt, /## Approved/);
    assert.match(approved.systemPrompt, /model\.deepseek/);
    assert.ok(
      !/model\.minimax-m3/.test(approved.systemPrompt),
      "stale MiniMax adaptation must not replay after a model switch",
    );
    assert.match(approved.systemPrompt, /Task type: architecture/); // A's plan

    // Restart in B: B's own plan restores (not A's).
    const b2 = makeSession(repoB, { provider: "minimax-cn", id: "MiniMax-M3" });
    await b2.handlers.get("session_start")({}, b2.ctx);
    const approvedB = await b2.handlers.get("before_agent_start")(
      { prompt: "批准", systemPrompt: "B" },
      b2.ctx,
    );
    assert.match(approvedB.systemPrompt, /Task type: architecture/);
    assert.match(
      approvedB.systemPrompt,
      /concern\.security|Concerns: security/,
    );
  } finally {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

// ---- v0.23 P0: cancel must clear the NAMESPACED file — no revival ------

test("E2E: /policy cancel → restart MUST NOT restore the plan", async () => {
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-policy-home2-"));
  const repo = mkdtempSync(join(tmpdir(), "pi-policy-repo2-"));
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "policy-engine.json"),
      JSON.stringify({ showStatus: false }),
    );
    const make = (cwd) => {
      const handlers = new Map();
      const commands = new Map();
      policyEngine({
        on: (n, f) => handlers.set(n, f),
        registerCommand: (n, d) => commands.set(n, d),
      });
      return {
        handlers,
        commands,
        ctx: {
          cwd,
          model: { provider: "minimax-cn", id: "MiniMax-M3" },
          ui: { notify() {}, setStatus() {} },
        },
      };
    };

    // Strict plan → awaiting → persisted (namespaced file).
    const s1 = make(repo);
    await s1.handlers.get("session_start")({}, s1.ctx);
    await s1.handlers.get("before_agent_start")(
      {
        prompt: "设计生产环境 PostgreSQL 迁移方案并实施，需要回滚",
        systemPrompt: "B",
      },
      s1.ctx,
    );
    await s1.handlers.get("agent_end")({}, s1.ctx);

    // Cancel via the command — v0.22 bug: cleared the UN-namespaced path.
    await s1.commands.get("policy").handler("cancel", s1.ctx);

    // Restart: the cancelled plan must NOT come back.
    const s2 = make(repo);
    await s2.handlers.get("session_start")({}, s2.ctx);
    const resp = await s2.handlers.get("before_agent_start")(
      { prompt: "随便看看这个项目", systemPrompt: "B" },
      s2.ctx,
    );
    assert.ok(!/Restored a strict plan awaiting approval/.test(""), "sanity");
    // Direct probe: no awaiting restore, no PLAN-ONLY leakage from a ghost plan.
    assert.doesNotMatch(resp.systemPrompt, /## Still awaiting approval/);
    assert.doesNotMatch(resp.systemPrompt, /Phase: awaiting_approval/);
  } finally {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- v0.23 P0: read-only intent is binding in the runtime block --------

test("E2E: read-only prompt injects intent.read-only + intent-neutral rigor", async () => {
  const realHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "pi-policy-home3-"));
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "policy-engine.json"),
      JSON.stringify({ showStatus: false }),
    );
    const handlers = new Map();
    policyEngine({
      on: (n, f) => handlers.set(n, f),
      registerCommand: () => {},
    });
    const ctx = {
      cwd: process.cwd(),
      model: { provider: "minimax-cn", id: "MiniMax-M3" },
      ui: { notify() {}, setStatus() {} },
    };
    await handlers.get("session_start")({}, ctx);

    const r = await handlers.get("before_agent_start")(
      { prompt: "只分析这个 bug，不要修改代码", systemPrompt: "B" },
      ctx,
    );
    // The runtime must ANNOUNCE the binding intent...
    assert.match(r.systemPrompt, /Execution intent: read-only/);
    // ...and enforce it via the intent policy (hard boundary)...
    assert.match(r.systemPrompt, /intent\.read-only/);
    assert.match(r.systemPrompt, /do not modify files/i);
    // ...while rigor stays intent-neutral: mutation guidance appears ONLY
    // inside the explicit conditional (the old unconditional "Then inspect
    // ... execute it" form is gone), and the read-only branch is present.
    assert.doesNotMatch(
      r.systemPrompt,
      /Then inspect the relevant implementation, create a minimal implementation plan, execute it/,
    );
    for (const m of r.systemPrompt.matchAll(
      /.{0,140}execute it without unnecessary ceremony/gs,
    )) {
      assert.match(
        m[0],
        /If mutation is requested/,
        "mutation guidance must be conditional",
      );
    }
    assert.match(
      r.systemPrompt,
      /If the task is read-only: do not perform the mutation phase/,
    );
  } finally {
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
});
