import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFooterConfigStore, defaultFooterConfig, footerConfigPath, resolveFooterConfig } from "../config.ts";

test("missing file materializes editable defaults and changes round-trip", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-footer-config-"));
  try {
    const path = footerConfigPath(root), store = createFooterConfigStore(path);
    assert.deepEqual(store.load(), defaultFooterConfig());
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), defaultFooterConfig());
    const config = resolveFooterConfig({ mode: "overview", style: { leftRatio: 0.6 }, views: { compact: { rows: [[null, { label: "项目", fields: ["project"] }]] } } });
    store.save(config); assert.deepEqual(store.load(), config);
    assert.equal(config.views.overview.rows.length, 2);
    assert.equal(config.views.overview.renderer, "bands");
    assert.equal(defaultFooterConfig().style.leftRatio, 0.5);
    writeFileSync(path, "{"); assert.throws(() => store.load(), /JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid nested settings fail with their path; obsolete placement configuration is not interpreted", () => {
  for (const [value, error] of [
    [{ mode: "wide" }, /mode/], [{ statusCells: {} }, /statusCells/], [{ style: { gap: 4 } }, /style.gap/],
    [{ style: { leftRatio: 1 } }, /style.leftRatio/], [{ style: { fieldGap: -1 } }, /style.fieldGap/],
    [{ style: { maxCellLines: 1.5 } }, /style.maxCellLines/], [{ style: { labelDivider: "yes" } }, /style.labelDivider/],
    [{ statusRoutes: {} }, /statusRoutes/], [{ views: { full: {} } }, /views.full/],
    [{ views: { compact: { rows: [[], []] } } }, /rows\[0\]/],
    [{ views: { compact: { rows: [[{ label: "项目", fields: ["unknown"] }]] } } }, /fields\[0\]/],
    [{ views: { overview: { renderer: "cards" } } }, /renderer/],
    [{ views: { overview: { showLabels: "yes" } } }, /showLabels/],
    [{ views: { overview: { style: { borders: "sometimes" } } } }, /borders/],
    [{ views: { overview: { rows: [[{ label: "X\nY", fields: [] }]] } } }, /label/],
    [{ views: { overview: { rows: [[{ label: "X", fields: [{ source: "model", prefix: "\x1b[31m" }] }]] } } }, /prefix/],
    [{ views: { overview: { rows: [[{ label: "X", fields: [{ status: "" }] }]] } } }, /status/],
    [{ views: { overview: { rows: [[{ label: "X", fields: [{ source: "model", status: "external" }] }]] } } }, /source 或 status/],
  ] as const) assert.throws(() => resolveFooterConfig(value), error);
  assert.deepEqual(resolveFooterConfig({ views: { compact: { rows: [] } } }).views.compact.rows, []);
});
