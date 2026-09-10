import assert from "node:assert/strict";
import test from "node:test";
import { renderBands } from "../bands.ts";
import { defaultFooterConfig } from "../config.ts";
import { visibleWidth } from "../layout.ts";

const plain = { fg: (_color: string, text: string) => text };
const style = { ...defaultFooterConfig().style, borders: "outer" as const, labelDivider: false };
const rows = [
  [{ label: "项目", items: ["pi-plugin", "main"] }, { label: "模型", items: ["glm-5.3", "high"] }],
  [{ label: "资源", items: ["12.4% / 1.0M", "◎98.9%", "↑58M", "↓3.7M"] }, { label: "额度", items: ["GLM 5h: 6%"] }],
  [{ label: "状态", items: ["审批 完全访问权限", "policy:auto ↑922 ↓69"] }, { label: "集成", items: ["MCP: 4 servers", "LSP Inactive"] }],
];

test("bands render natural columns with outer rules and no cell frames", () => {
  const lines = renderBands(rows, 160, style, plain, true);
  assert.equal(lines.length, 5);
  assert.ok(lines[0].split("").every(char => char === "─"));
  assert.match(lines[1], /^项目  pi-plugin +main\s+模型  glm-5\.3/);
  assert.match(lines[2], /^资源  12\.4% \/ 1\.0M +◎98\.9% +↑58M +↓3\.7M\s+额度  GLM/);
  assert.doesNotMatch(lines.join("\n"), /[│┬┴┼]/);
  assert.ok(lines.every(line => visibleWidth(line) === 160));
});

test("bands support hidden labels, wrapping, ellipsis and narrow single-column flow", () => {
  const hidden = renderBands(rows, 120, { ...style, borders: "none" }, plain, false);
  assert.doesNotMatch(hidden.join("\n"), /项目|模型|资源|额度|状态|集成/);
  const clipped = renderBands(rows, 80, { ...style, overflow: "ellipsis", narrowWidth: 20 }, plain, true);
  assert.ok(clipped.every(line => visibleWidth(line) <= 80));
  const narrow = renderBands(rows, 50, style, plain, true);
  assert.ok(narrow.length >= 8);
  assert.ok(narrow.every(line => visibleWidth(line) === 50));
  assert.deepEqual(renderBands(rows, NaN, style, plain), []);
});
