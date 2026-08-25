// v0.20: strict-plan state persists across session restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateFile = join(mkdtempSync(join(tmpdir(), "pi-policy-ss-")), "strict-state.json");
const cwdA = mkdtempSync(join(tmpdir(), "pi-policy-ss-a-"));
const cwdB = mkdtempSync(join(tmpdir(), "pi-policy-ss-b-"));

test("save/load/clear round-trip (unit, fs mock)", async () => {
  const { saveStrictState, loadStrictState, clearStrictState } = await import(
    "../src/core/history-store.js"
  );
  const store = new Map();
  const fs = {
    async readFile(p) { return store.get(p) ?? ""; },
    async writeFile(p, d) { store.set(p, d); },
    async mkdir() {},
  };
  const decision = {
    taskType: "architecture", risk: "high", confidence: 0.9,
    executionIntent: "mutate", domains: ["database"], concerns: ["production"],
    rigor: "strict", flow: null, profile: "architecture",
    modelPolicy: null, reasons: ["r1"],
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
    async writeFile(p, d) { store.set(p, d); },
    async mkdir() {},
  };
  const decision = { rigor: "strict", taskType: "coding", risk: "high", domains: [] };
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
    taskType: "architecture", risk: "high", confidence: 0.9,
    executionIntent: "mutate", domains: ["database"], concerns: ["production"],
    rigor: "strict", flow: null, profile: "architecture",
    modelPolicy: null, reasons: [],
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
