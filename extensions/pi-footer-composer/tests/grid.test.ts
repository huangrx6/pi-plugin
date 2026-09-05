import assert from "node:assert/strict";
import test from "node:test";
import { renderGrid } from "../grid.ts";
import { visibleWidth } from "../layout.ts";

const theme = { fg: (_color: string, text: string) => text };

test("category divider stays aligned across widths without outer side borders", () => {
  const rows = [
    { label: "路径", items: ["~/工作区/" + "长路径/".repeat(15), "分支 main"] },
    { label: "模型", items: ["glm-5.3", "平台 zai", "思考 high"] },
    { label: "用量", items: ["输入 4.4M", "输出 148k"] },
  ];
  for (const width of [1, 4, 5, 9, 10, 38, 79, 100, 118, 157, 180, 201]) {
    const lines = renderGrid(rows, width, theme);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.every(line => !/^[│┌├└]|[│┐┤┘]$/.test(line)));
    if (width < 10) continue;
    assert.ok(lines.every(line => visibleWidth(line) === width));
    const positions = (line: string) => {
      const columns: number[] = [];
      let col = 0;
      for (const char of line) {
        if ("│┌┬┐├┼┤└┴┘".includes(char)) columns.push(col);
        col += visibleWidth(char);
      }
      return columns;
    };
    for (const line of lines) assert.deepEqual(positions(line), [6]);
  }
});

test("related fields share a row; long content wraps under one category label", () => {
  const lines = renderGrid([
    { label: "路径", items: ["一".repeat(45), "分支 main"] },
    { label: "模型", items: ["glm-5.3", "平台 zai", "思考 high"] },
    { label: "集成", items: [] },
  ], 79, theme);
  assert.equal(lines.join("").match(/一/g)?.length, 45);
  assert.equal(lines.join("").match(/路径/g)?.length, 1);
  assert.ok(lines.some(line => /模型.*glm-5.3.*平台 zai.*思考 high/.test(line)));
  assert.doesNotMatch(lines.join(""), /集成/);
  assert.ok(lines.some(line => /^ {6}│/.test(line)));
  const narrow = renderGrid([{ label: "用量", items: ["输入 4.4M", "输出 148k"] }], 24, theme);
  assert.ok(narrow.some(line => line.includes("输入 4.4M")));
  assert.ok(narrow.some(line => line.includes("输出 148k")));
});

test("all content uses muted gray, borders dim, external styling is stripped", () => {
  const calls: [string, string][] = [];
  renderGrid([{ label: "状态", items: ["\x1b[1m亮色\x1b[0m\x1b]9;bad\x07\u202e", "正常"] }], 80, {
    fg(color, text) { calls.push([color, text]); return text; },
  });
  assert.ok(calls.every(([color, text]) => ["muted", "dim"].includes(color) && !/[\x1b\u202e]/.test(text)));
  assert.ok(calls.some(([color, text]) => color === "muted" && text.includes("亮色")));
});
