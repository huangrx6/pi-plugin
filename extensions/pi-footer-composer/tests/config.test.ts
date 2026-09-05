/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFooterConfigStore,
  footerConfigPath,
} from "../config.ts";

test("missing footer config defaults to compact and save round-trips", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-footer-config-"));
  try {
    const path = footerConfigPath(root);
    const store = createFooterConfigStore(path);
    assert.deepEqual(store.load(), { mode: "compact" });

    store.save({ mode: "full" });
    assert.deepEqual(store.load(), { mode: "full" });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mode: "full" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid footer config fails with a useful setting error", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-footer-config-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ mode: "wide" }));
    assert.throws(() => createFooterConfigStore(path).load(), /mode 必须是 compact、full 或 native/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
