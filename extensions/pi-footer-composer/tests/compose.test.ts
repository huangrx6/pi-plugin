import assert from "node:assert/strict";
import test from "node:test";
import { composeRows } from "../compose.ts";
import { collectSnapshot, type Snapshot } from "../data.ts";
import type { ViewConfig } from "../settings.ts";
const snapshot: Snapshot = { fields: { model: "model-x", project: "workspace", context: "12.4% / 1.0M" }, contextPercent: 12.4, statuses: [
  { key: "config:workflow", text: "workflow:auto ↑922 ↓69" },
  { key: "config:mode", text: "权限 full" },
  { key: "external", text: "LSP error\nmain.ts details" },
  { key: "context:summary", text: "Context 12%" },
  { key: "context:paused", text: "Context 12% · 暂停" },
] };
test("row order, side, field order, labels, literals and full-width cells come from configuration", () => {
  const rows = composeRows({ renderer: "table", showLabels: true, rows: [
    [null, { label: "自选", fields: ["model", { source: "project", prefix: "目录 ", suffix: " /" }] }],
    [{ label: "提示", fields: [{ source: "branch", empty: "无分支" }] }],
  ] }, snapshot);
  assert.deepEqual(rows, [[null, { label: "自选", items: ["model-x", "目录 workspace /"] }], [{ label: "提示", items: ["无分支"] }]]);
});
test("configured status keys are reserved before remaining, independent of row order", () => {
  const rows = composeRows({ renderer: "table", showLabels: true, rows: [
    [{ label: "其他", fields: ["remaining"] }],
    [{ label: "状态", fields: [{ status: "config:mode" }] }, { label: "策略", fields: [{ status: "config:workflow" }] }],
  ] }, snapshot);
  assert.deepEqual(rows[1], [{ label: "状态", items: ["权限 full"] }, { label: "策略", items: ["workflow:auto ↑922 ↓69"] }]);
  assert.equal(rows.flat().flatMap(cell => cell?.items || []).filter(text => text.includes("↑922")).length, 1);
  assert.ok(rows[0][0]?.items.includes("LSP error\nmain.ts details"));
});
test("hidden configured statuses are suppressed, empty slots remain and context dedup requires a visible built-in", () => {
  const view: ViewConfig = { renderer: "table", showLabels: true, rows: [[{ label: "隐藏", fields: [{ status: "external" }], hidden: true }, { label: "窗口", fields: ["context", "remaining"] }]] };
  const rows = composeRows(view, snapshot);
  assert.equal(rows[0][0], null);
  assert.ok(rows[0][1]?.items.includes("Context 12% · 暂停"));
  assert.ok(!rows[0][1]?.items.includes("Context 12%"));
  assert.ok(!rows[0][1]?.items.some(text => text.includes("LSP")));
  assert.ok(composeRows({ renderer: "table", showLabels: true, rows: [[{ label: "状态", fields: ["remaining"] }]] }, snapshot)[0][0]?.items.includes("Context 12%"));
});
test("data uses latest assistant cache ratio, includes all recorded usage and preserves sanitized status text", () => {
  const data = collectSnapshot({ sessionManager: {
    getCwd: () => "/tmp/workspace", getSessionName: () => "test",
    getEntries: () => [
      { type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 900, output: 50, cost: { total: 0.1 } } } },
      { type: "message", message: { role: "toolResult", usage: { input: 5, cost: { total: 0.2 } } } },
      { type: "compaction", usage: { output: 10 } },
      { type: "message", message: { role: "assistant", usage: { input: 10, cacheRead: 10 } } },
    ],
  } }, { id: "model", provider: "platform", reasoning: true, contextWindow: 1000000 }, "high", "main", new Map([["external", "\x1b[31mLSP detail\x1b[0m\nnext line"]]));
  assert.equal(data.fields.cacheHit, "◎50.0%");
  assert.equal(data.fields.context, "? / 1.0M");
  assert.equal(data.fields.output, "↓60");
  assert.equal(data.fields.input, "↑115");
  assert.equal(data.fields.cost, "$0.300");
  assert.equal(data.statuses[0].key, "external");
  assert.equal(data.statuses[0].text, "LSP detail\nnext line");
});
