import assert from "node:assert/strict";
import test from "node:test";
import { renderTable } from "../table.ts";
import { visibleWidth } from "../layout.ts";
import { defaultFooterConfig } from "../config.ts";
const plain = { fg: (_color: string, text: string) => text };
const style = defaultFooterConfig().style;
const rows = [
  [{ label: "项目", items: ["pi-plugin", "main"] }, { label: "模型", items: ["model", "high"] }],
  [{ label: "策略", items: ["policy:auto ↑922 ↓69"] }, { label: "诊断", items: ["LSP Inactive"] }],
];
test("paired and spanning rows share aligned boundaries without side frames", () => {
  const lines = renderTable([...rows, [{ label: "集成", items: ["full width content"] }]], 120, style, plain);
  assert.equal(lines.length, 7);
  for (const line of lines) assert.equal(visibleWidth(line), 120);
  assert.match(lines[1], /项目 │ pi-plugin +main.*模型 │ model/);
  assert.ok(lines[4].includes("┴"), "right divider ends before the full-width row");
  assert.ok(lines.every(line => !line.startsWith("│") && !line.endsWith("│")));
});
test("every style option controls layout; empty slots don't shift the other cell", () => {
  const custom = { ...style, borders: "none" as const, labelDivider: false, labelWidth: 6, fieldGap: 1, columnGap: 5, leftRatio: 0.6 };
  const lines = renderTable(rows, 120, custom, plain);
  assert.equal(lines.length, 2); assert.doesNotMatch(lines.join("\n"), /[─│┬┴┼]/);
  assert.match(lines[0], /pi-plugin main/);
  assert.equal(visibleWidth(lines[0].split("模型")[0]), Math.floor((120 - 5) * 0.6) + 6);
  assert.equal(renderTable(rows, 120, { ...style, borders: "outer" }, plain).length, 4);
  const blank = renderTable([[null, rows[0][1]]], 120, style, plain);
  assert.match(blank[1], /^\s+│\s+模型 │ model/);
});
test("wrap preserves full status suffix and graphemes across widths; ellipsis and line limits are explicit", () => {
  const long = "中é👩‍💻".repeat(25);
  const data = [[{ label: "项目", items: [long, "feat/long-name"] }, { label: "诊断", items: ["LSP details\nmain.ts"] }]];
  for (const width of [1, 2, 5, 10, 30, 71, 72, 99, 120, 240]) {
    const lines = renderTable(data, width, style, plain);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}`);
    if (width >= 72) {
      const text = lines.filter(line => line.includes("│")).map(line => line.split("│")[1].trim().replace(/诊断$/, "").trim()).join("");
      assert.ok(text.includes(long), `${width}: content must be complete`);
    }
  }
  const limit = renderTable(data, 100, { ...style, maxCellLines: 2 }, plain);
  assert.equal(limit.length, 4); assert.match(limit.join("\n"), /…/);
  const clipped = renderTable(data, 100, { ...style, overflow: "ellipsis" }, plain);
  assert.equal(clipped.length, 3); assert.match(clipped.join("\n"), /…/);
  assert.deepEqual(renderTable(data, NaN, style, plain), []);
});
test("gray defaults strip external styles; configured text and border colors are applied only by renderer", () => {
  const calls: [string, string][] = [];
  renderTable([[{ label: "窗口", items: ["\x1b[31m95%\x1b[0m"] }]], 80, style, { fg: (color, text) => { calls.push([color, text]); return text; } });
  assert.ok(calls.every(([color, text]) => ["muted", "dim"].includes(color) && !text.includes("\x1b")));
  assert.ok(calls.some(([color, text]) => color === "muted" && text.includes("95%")));
});
