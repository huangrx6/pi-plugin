import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadPersistedMode, modeConfigPaths, persistMode } from "../index.ts";

test("mode reads and writes only its canonical extension namespace", () => {
  const root = mkdtempSync(join(tmpdir(), "mode-paths-"));
  try {
    const paths = modeConfigPaths(root);
    assert.equal(loadPersistedMode(root), "smart");
    persistMode("full", root);
    assert.equal(paths.current, join(root, "extensions-data", "pi-mode-switcher", "config.json"));
    assert.equal(loadPersistedMode(root), "full");
    writeFileSync(paths.current, "invalid json");
    assert.equal(loadPersistedMode(root), "smart");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mode persistence failures remain nonfatal", () => {
  const root = mkdtempSync(join(tmpdir(), "mode-paths-"));
  try {
    const path = modeConfigPaths(root).current;
    mkdirSync(dirname(dirname(path)), { recursive: true });
    writeFileSync(dirname(path), "blocks directory creation");
    assert.doesNotThrow(() => persistMode("ask", root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
