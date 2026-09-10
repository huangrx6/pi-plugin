import assert from "node:assert/strict";
import test from "node:test";
import { renderCompact } from "../compact.ts";
import { visibleWidth } from "../layout.ts";

const plain = { fg: (_color: string, text: string) => text };
const groups = [
  { primary: "智能文档解析平台", secondary: "feat/log-v2-base", statuses: ["权限 full", "状态待确认"] },
  { primary: "glm-5.3", secondary: "provider · high", statuses: ["5h 63% · 周 88%"] },
  { primary: "上下文 10.8%", secondary: "命中率 99.5%", statuses: ["暂停", "MCP ready"] },
];

test("semantic column positions stay fixed across status changes", () => {
  const lines = renderCompact(groups, 120, plain);
  assert.equal(lines[1].indexOf("glm-5.3") + visibleWidth("智能文档解析平台") - "智能文档解析平台".length, 41);
  assert.equal(lines[3], "");
  assert.doesNotMatch(lines.join("\n"), /[│┼┬┴]/);
  const changed = groups.map(group => ({ ...group, statuses: ["long ".repeat(40)] }));
  assert.deepEqual(renderCompact(changed, 120, plain).slice(0, 4), lines.slice(0, 4));
});

test("narrow and wide layouts preserve statuses and never exceed terminal width", () => {
  const data = groups.map(group => ({ ...group, statuses: [...group.statuses, "中é👩‍💻".repeat(25), "multi\nline"] }));
  for (const width of [1, 2, 5, 30, 80, 99, 100, 120, 132, 240]) {
    const lines = renderCompact(data, width, plain);
    assert.ok(lines.every(line => visibleWidth(line) <= Math.min(width, 132)), `width ${width}`);
    if (width >= 30) {
      assert.match(lines.join("\n"), /状态待确认/);
      assert.match(lines.join("\n"), /MCP ready/);
      assert.match(lines.join("\n"), /暂停/);
    }
  }
  assert.deepEqual(renderCompact(groups, 0, plain), []);
  assert.deepEqual(renderCompact(groups, NaN, plain), []);
});

test("external styling is stripped, secondary text is muted and explicit warning survives", () => {
  const calls: [string, string][] = [];
  const lines = renderCompact([{ primary: "\x1b[31m上下文 95%\x1b[0m", primaryTone: "error", secondary: "secondary", statuses: ["\x1b]9;hidden\x07MCP ready"] }], 120, {
    fg: (color, text) => { calls.push([color, text]); return text; },
  });
  assert.ok(calls.some(([color, text]) => color === "error" && text === "上下文 95%"));
  assert.ok(calls.some(([color, text]) => color === "muted" && text === "secondary"));
  assert.doesNotMatch(lines.join("\n"), /hidden|\x1b/);
});
