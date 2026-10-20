import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFooterConfigStore, defaultFooterConfig, footerConfigPath, migrateLegacyConfig, resolveFooterConfig } from "../config.ts";

test("strict config rejects typos, ambiguous keys and unsafe text", () => {
  assert.deepEqual(resolveFooterConfig({}), defaultFooterConfig());
  for (const value of [{ version: 6 }, { collapsed: true }, { style: { panelWidth: 1 } }, { style: { gap: NaN } }, { more: { sections: [{ label: "X", status: "\x1b[31mfoo" }] } }, { more: { sections: [{ label: "A", status: "a" }, { label: "B", status: "a" }] } }]) assert.throws(() => resolveFooterConfig(value));
});
test("legacy selectors migrate once with byte-for-byte backup, hidden policy and generic status groups", () => {
  const dir = mkdtempSync(join(tmpdir(), "footer-config-"));
  try {
    const path = footerConfigPath(dir), store = createFooterConfigStore(path); store.load();
    const legacy = { mode: "compact", views: { compact: { rows: [[{ label: "状态", fields: [{ status: "access" }, "remaining"] }, { label: "策略", fields: [{ status: "policy" }] }]] } } };
    const raw = JSON.stringify(legacy); writeFileSync(path, raw);
    const migrated = store.load(); assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.more.sections, [{ label: "状态", status: "access" }, { label: "策略", status: "policy", hidden: true }]);
    const backupDir = join(dir, "extensions-data", ".backups", "pi-footer-composer");
    assert.equal(readFileSync(join(backupDir, readdirSync(backupDir)[0]), "utf8"), raw);
    assert.deepEqual(store.load(), migrated); assert.equal(readdirSync(backupDir).length, 1);
    const broken = '{"views":{"compact":{"rows":false}}}'; writeFileSync(path, broken);
    assert.throws(() => store.load()); assert.equal(readFileSync(path, "utf8"), broken);
    assert.equal(readdirSync(backupDir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("legacy native mode and inactive view selection are preserved", () => {
  assert.equal(migrateLegacyConfig({ mode: "native" }).mode, "native");
  const c = migrateLegacyConfig({ mode: "overview", views: { compact: { rows: [] }, overview: { rows: [[{ label: "额度", fields: [{ status: "quota" }] }]] } } });
  assert.equal(c.more.sections[0].status, "quota");
});
test("invalid fields anywhere in a legacy config are rejected before migration", () => {
  for (const value of [
    { collapsed: "yes" }, { style: { columnGap: -1 } },
    { views: { compact: { rows: [[{ label: "X", fields: [{ source: "model", status: "both" }] }]] } } },
    { mode: "overview", views: { overview: { rows: [] }, compact: { rows: [[{ label: "X", fields: ["typo"] }]] } } },
  ]) assert.throws(() => migrateLegacyConfig(value));
  assert.equal(migrateLegacyConfig({ views: { compact: { renderer: "table" } } }).version, 5);
});

test("a hidden legacy remaining slot stays hidden", () => {
  const c = migrateLegacyConfig({ views: { compact: { rows: [[{ label: "其他", fields: ["remaining"], hidden: true }]] } } });
  assert.equal(c.more.includeUnmapped, false);
});
