import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULTS,
  agentDir,
  configPath,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from "../config.ts";

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-throughput-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("agentDir follows PI_CODING_AGENT_DIR and falls back to the default", () => {
  assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "   " }), join(homedir(), ".pi", "agent"));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/custom" }), join(homedir(), "custom"));
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/srv/agent" }), "/srv/agent");
});

test("configPath lives under extensions-data/<package>", () => {
  const path = configPath({ PI_CODING_AGENT_DIR: "/srv/agent" });
  assert.equal(path, join("/srv/agent", "extensions-data", "pi-throughput", "config.json"));
});

test("normalizeConfig coerces invalid values back to defaults", () => {
  assert.deepEqual(normalizeConfig(null), DEFAULTS);
  assert.deepEqual(normalizeConfig("nope"), DEFAULTS);
  assert.deepEqual(normalizeConfig({ display: "everything", measurement: "average" }), DEFAULTS);
  const clamped = normalizeConfig({ minWindowMs: 5, throttleMs: -20, unknown: true });
  assert.equal(clamped.minWindowMs, 100);
  assert.equal(clamped.throttleMs, 0);
  assert.equal("unknown" in clamped, false);
  const kept = normalizeConfig({
    enabled: false,
    display: "ttft",
    measurement: "e2e",
    retainFinal: false,
    history: false,
    minWindowMs: 1200.6,
    throttleMs: 4000,
  });
  assert.deepEqual(kept, {
    enabled: false,
    display: "ttft",
    measurement: "e2e",
    retainFinal: false,
    history: false,
    minWindowMs: 1201,
    throttleMs: 4000,
  });
});

test("loadConfig returns defaults when the file is missing or corrupt", (t) => {
  const dir = tempDir(t);
  const env = { PI_CODING_AGENT_DIR: dir };
  assert.deepEqual(loadConfig(env), DEFAULTS);
  const path = configPath(env);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, "{ not json");
  assert.deepEqual(loadConfig(env), DEFAULTS);
});

test("saveConfig round-trips through disk", (t) => {
  const env = { PI_CODING_AGENT_DIR: tempDir(t) };
  const config = { ...DEFAULTS, enabled: false, display: "tps" as const, measurement: "e2e" as const };
  saveConfig(config, env);
  assert.deepEqual(loadConfig(env), config);
});

test("shipped defaults.json mirrors the in-code DEFAULTS", () => {
  const raw = readFileSync(new URL("../config/defaults.json", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(raw), DEFAULTS);
});
