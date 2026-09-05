import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { globalConfigFile, loadEffectiveConfig } from "../src/core/config.js";
import { defaultHistoryPath, strictStatePath } from "../src/core/history-store.js";
import { agentDirectory, extensionDirectory, globalConfigPath } from "../src/core/paths.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-paths-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const config = () => loadEffectiveConfig({ packageRoot, cwd: root });
  return { root, write, config };
}

test("new installations group config and durable state under the selected agent directory", (t) => {
  const { root, config } = fixture(t);
  const expected = join(root, "extensions-data", "pi-policy-engine");
  assert.equal(extensionDirectory(), expected);
  assert.equal(globalConfigPath(), join(expected, "config.json"));
  assert.equal(globalConfigFile(), null);
  assert.equal(config().historyFile, join(expected, "state", "history.jsonl"));
  assert.equal(defaultHistoryPath(), config().historyFile);
  assert.equal(dirname(strictStatePath(config().historyFile, root)), join(expected, "state"));
  assert.equal(existsSync(expected), false, "resolving paths must not create or move files");
});

test("broken current config is diagnosed without changing the defaults", (t) => {
  const { root, write, config } = fixture(t);
  const current = join(extensionDirectory(), "config.json");
  write(current, {});
  writeFileSync(current, "{broken");
  assert.equal(globalConfigFile().path, current);
  assert.ok(globalConfigFile().error);
  assert.equal(config().mode, "auto");
});

test("explicit history paths and disabled persistence override all directory defaults", (t) => {
  const { root, write, config } = fixture(t);
  const current = join(extensionDirectory(), "config.json");
  for (const historyFile of [join(root, "custom", "history.jsonl"), "~/my-history.jsonl", "", null]) {
    write(current, { historyFile });
    assert.equal(config().historyFile, historyFile);
  }
});

test("agent directory defaults and home expansion follow the host setting", (t) => {
  fixture(t);
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(agentDirectory(), join(homedir(), ".pi", "agent"));
  process.env.PI_CODING_AGENT_DIR = "~/pi-test-agent";
  assert.equal(agentDirectory(), join(homedir(), "pi-test-agent"));
});
