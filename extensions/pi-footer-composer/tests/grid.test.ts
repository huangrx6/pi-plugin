import assert from "node:assert/strict";
import test from "node:test";
import { renderGrid } from "../grid.ts";
import { visibleWidth } from "../layout.ts";

const theme = { fg: (_color: string, text: string) => text };

test("every row shares fixed boundaries at responsive widths", () => {
  const items = ["路径  ~/工作区/" + "长路径/".repeat(15), "模型  glm-5.3", "平台  zai", "思考 high", "输入 4.4M", "输出 148k", "警告 ! 配置错误"];
  for (const width of [1, 4, 5, 38, 79, 100, 118, 157, 180, 201]) {
    const lines = renderGrid(items, width, theme);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width < 5) continue;
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
    for (const line of lines) assert.deepEqual(positions(line), positions(lines[0]));
  }
});

test("one item per box, long content wraps without loss, final cells stay empty", () => {
  const lines = renderGrid(["一".repeat(45), "独立内容", "第三项"], 79, theme);
  assert.equal(lines.join("").match(/一/g)?.length, 45);
  assert.equal(lines.join("").match(/独立内容/g)?.length, 1);
  assert.equal(lines[0].split("┬").length, 2);
  assert.match(lines.at(-2)!, /│ +│$/);
});

test("all content uses muted gray, borders dim, external styling is stripped", () => {
  const calls: [string, string][] = [];
  renderGrid(["\x1b[1m亮色\x1b[0m\x1b]9;bad\x07\u202e", "正常"], 80, {
    fg(color, text) { calls.push([color, text]); return text; },
  });
  assert.ok(calls.every(([color, text]) => ["muted", "dim"].includes(color) && !/[\x1b\u202e]/.test(text)));
  assert.ok(calls.some(([color, text]) => color === "muted" && text.includes("亮色")));
});
