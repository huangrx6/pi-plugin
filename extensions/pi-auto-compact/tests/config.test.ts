import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, translateLegacy } from "../config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-compact-config-"));
  const agent = join(root, "agent"); const cwd = join(root, "project");
  const global = join(agent, "extensions-data", "pi-auto-compact", "config.json");
  const legacy = join(agent, "extensions-data", "pi-context-qos", "config.json");
  const project = join(cwd, ".pi", "auto-compact.json"); const oldProject = join(cwd, ".pi", "context-qos.json");
  return { root, agent, cwd, global, legacy, project, oldProject,
    write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); },
    close() { rmSync(root, { recursive: true, force: true }); },
    load(trusted = true) { return loadConfig(cwd, trusted, agent); },
  };
}

test("fresh config needs no directories or state writes", () => {
  const h = fixture(); try { assert.deepEqual(h.load(), DEFAULT_CONFIG); assert.deepEqual(readdirSync(h.root), []); } finally { h.close(); }
});
test("legacy percentage preserves the actual full-window trigger and disabled native fallback", () => {
  assert.deepEqual(translateLegacy({ budget: { critical: 0.6 } }), { enabled: true, thresholdPercent: 49.2 });
  assert.equal(translateLegacy({ budget: { nativeCompactFallback: false } }).enabled, false);
  assert.equal(translateLegacy({ enabled: false }).enabled, false);
  assert.equal(translateLegacy({ budget: { critical: 0.001 } }).thresholdPercent, 0.082);
  assert.throws(() => translateLegacy({ budget: "bad" }));
  for (const config of [{ enabled: null }, { budget: null }, { budget: { critical: null } }, { budget: { outputReserveRatio: null } }, { budget: { safetyReserveRatio: null } }]) assert.throws(() => translateLegacy(config));
});
test("new global supersedes legacy global; trusted project remains the last layer", () => {
  const h = fixture(); try {
    h.write(h.legacy, { budget: { critical: 0.6 } }); assert.equal(h.load().thresholdPercent, 49.2);
    h.write(h.global, { thresholdPercent: 70 }); assert.equal(h.load().thresholdPercent, 70);
    h.write(h.oldProject, { budget: { critical: 0.5 } }); assert.throws(() => h.load(), /请将项目/);
    assert.equal(h.load(false).thresholdPercent, 70);
    h.write(h.project, { thresholdPercent: 65 }); assert.equal(h.load().thresholdPercent, 65);
    h.write(h.oldProject, { budget: "invalid" }); assert.equal(h.load().thresholdPercent, 65, "new project supersedes malformed old file");
  } finally { h.close(); }
});
test("legacy project storage alone does not override new defaults; legacy budgets merge", () => {
  const h = fixture(); try {
    h.write(h.oldProject, { storage: { directory: "/unused" } }); assert.deepEqual(h.load(), DEFAULT_CONFIG);
    h.write(h.legacy, { enabled: false, budget: { critical: 0.6, outputReserveRatio: 0.2 } });
    h.write(h.oldProject, { budget: { safetyReserveRatio: 0.1 } });
    assert.deepEqual(h.load(), { enabled: false, thresholdPercent: 42 });
  } finally { h.close(); }
});
test("invalid new config is reported, never silently replaced by fallback", () => {
  const h = fixture(); try {
    h.write(h.global, { thresholdPercent: 100 }); assert.throws(() => h.load(), /thresholdPercent/);
    h.write(h.global, { enabled: "false" }); assert.throws(() => h.load(), /enabled/);
    h.write(h.global, { thresholdPercent: 0.5 }); assert.equal(h.load().thresholdPercent, 0.5);
    h.write(h.oldProject, { budget: [] }); assert.throws(() => h.load(), /budget/);
  } finally { h.close(); }
});
