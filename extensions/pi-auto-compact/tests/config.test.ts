import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-compact-config-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  const global = join(agent, "extensions-data", "pi-auto-compact", "config.json");
  const project = join(cwd, ".pi", "auto-compact.json");
  return {
    root, agent, cwd, global, project,
    write(path: string, value: unknown) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value));
    },
    close() { rmSync(root, { recursive: true, force: true }); },
    load(trusted = true) { return loadConfig(cwd, trusted, agent); },
  };
}

test("fresh config needs no directories or state writes", () => {
  const h = fixture();
  try {
    assert.deepEqual(h.load(), DEFAULT_CONFIG);
    assert.deepEqual(readdirSync(h.root), []);
  } finally { h.close(); }
});

test("canonical global and trusted project settings layer cleanly", () => {
  const h = fixture();
  try {
    h.write(h.global, { thresholdPercent: 70 });
    assert.deepEqual(h.load(), { enabled: true, thresholdPercent: 70 });
    h.write(h.project, { enabled: false, thresholdPercent: 45 });
    assert.deepEqual(h.load(), { enabled: false, thresholdPercent: 45 });
    assert.deepEqual(h.load(false), { enabled: true, thresholdPercent: 70 });
  } finally { h.close(); }
});

test("invalid canonical config fails closed", () => {
  const h = fixture();
  try {
    h.write(h.global, { thresholdPercent: 100 });
    assert.throws(() => h.load(), /thresholdPercent/);
    h.write(h.global, { enabled: "false" });
    assert.throws(() => h.load(), /enabled/);
  } finally { h.close(); }
});

test("retired paths are ignored", () => {
  const h = fixture();
  try {
    h.write(join(h.agent, "extensions-data", "pi-context-qos", "config.json"), { budget: { critical: 0.1 } });
    h.write(join(h.cwd, ".pi", "context-qos.json"), { enabled: false });
    assert.deepEqual(h.load(), DEFAULT_CONFIG);
  } finally { h.close(); }
});
