/**
 * plan-card.test.js — 计划卡片行生成覆盖(0.41.0)。
 *
 *   A. planSummaryLine:折叠单行不超宽,展开提示在窄终端下仍可见。
 *   B. planCardRows:展开卡片含标题/编号步骤/✓ 验证/脚注;
 *      多行 goal、≥10 步编号、无效计划回退。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	planCardRows,
	planSummaryLine,
} from "../extensions/policy-engine/plan-card.js";
import { displayWidth } from "../extensions/policy-engine/terminal.js";

const PLAN = {
	planVersion: 4,
	goal: "修复技术拓扑图画布拥挤",
	steps: [
		{ action: "改 X 坐标数组", verification: "tsc --noEmit 通过" },
		{ action: "line-clamp-3 改 line-clamp-2", verification: "grep 确认" },
	],
};

describe("planSummaryLine", () => {
	it("fits any width and always keeps the expand hint", () => {
		for (const width of [120, 80, 60, 40]) {
			const line = planSummaryLine(PLAN, width);
			assert.ok(displayWidth(line) <= width, `width ${width}: ${line}`);
			assert.ok(line.includes("ctrl+o"), `hint kept at ${width}: ${line}`);
			assert.ok(line.includes("v4"), `version at ${width}: ${line}`);
			assert.ok(line.includes("2 步"), `steps at ${width}: ${line}`);
		}
		// 极窄终端:头部之外全部让位,但行宽仍不可超。
		const narrow = planSummaryLine(PLAN, 20);
		assert.ok(displayWidth(narrow) <= 20, narrow);
	});

	it("shows a placeholder for missing or malformed plans", () => {
		assert.match(planSummaryLine(null, 80), /等待参数/);
		assert.match(planSummaryLine({ goal: "", steps: [] }, 80), /等待参数/);
	});
});

describe("planCardRows", () => {
	it("renders header, numbered steps, verifications and footer", () => {
		const rows = planCardRows(PLAN, 80);
		const texts = rows.map((r) => r.text);
		assert.ok(texts[0].startsWith("Policy Plan v4 · 修复技术拓扑图画布拥挤"));
		assert.ok(texts.some((t) => t.includes("01") && t.includes("改 X 坐标数组")));
		assert.ok(texts.some((t) => t.includes("02")));
		assert.ok(
			texts.some((t) => t.includes("✓") && t.includes("tsc --noEmit 通过")),
		);
		assert.equal(texts.at(-1), "2 步 · 等待审批");
		assert.ok(rows.every((r) => displayWidth(r.text) <= 80));
		assert.deepEqual([...new Set(rows.map((r) => r.tone))].sort(), [
			"accent",
			"dim",
			"success",
			"text",
		]);
	});

	it("keeps continuation rows within width for CJK content", () => {
		const wide = {
			planVersion: 1,
			goal: "这是一个非常长的中文目标说明需要折行处理验证宽度控制逻辑是否正确",
			steps: [
				{
					action: "这一步的动作描述同样非常长需要在窄终端下正确折行而不破坏布局",
					verification: "验证文本也很长需要折行检查缩进对齐效果是否依然完好",
				},
			],
		};
		for (const width of [72, 48, 32]) {
			const rows = planCardRows(wide, width);
			assert.ok(rows.length > 3);
			assert.ok(rows.every((r) => displayWidth(r.text) <= width));
		}
	});

	it("renders multi-line goal extra lines without blank filler", () => {
		const rows = planCardRows({ ...PLAN, goal: "第一行\n第二行说明" }, 80);
		assert.ok(rows.some((r) => r.text.trim() === "第二行说明"));
		assert.ok(!rows.some((r) => r.text.trim() === "" && r.tone === "text"));
	});

	it("numbers steps beyond 09 without gaps", () => {
		const many = {
			planVersion: 1,
			goal: "g",
			steps: Array.from({ length: 11 }, (_, i) => ({
				action: `step ${i}`,
				verification: `check ${i}`,
			})),
		};
		const texts = planCardRows(many, 100).map((r) => r.text);
		assert.ok(texts.some((t) => t.includes(" 10  step 9")));
		assert.ok(texts.some((t) => t.includes(" 11  step 10")));
		assert.equal(texts.at(-1), "11 步 · 等待审批");
	});

	it("falls back to a dim placeholder row for unusable plans", () => {
		const rows = planCardRows(null, 80);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].tone, "dim");
		assert.match(rows[0].text, /计划数据不可用/);
	});
});
