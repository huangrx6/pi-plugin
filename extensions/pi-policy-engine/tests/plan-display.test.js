/**
 * plan-display.test.js — policy-plan 文本块显示折叠覆盖(0.41.0)。
 *
 *   A. 无 fence 的文本原样返回(同引用)。
 *   B. 合法 JSON 块 → 一行摘要(版本/步数/目标预览)。
 *   C. 坏 JSON / 空块 → 通用占位,原始 JSON 不外露。
 *   D. 多块全部折叠;摘要自身不再含 ``` fence。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { transformPlanBlocks } from "../src/core/plan-display.js";

const VALID_BLOCK = `\`\`\`policy-plan
{"taskId":"t1","planVersion":4,"goal":"修复技术拓扑图画布拥挤","steps":[{"action":"a","verification":"v"},{"action":"b","verification":"w"}]}
\`\`\``;

describe("transformPlanBlocks", () => {
	it("returns non-string and fence-free markdown untouched", () => {
		const md = "# 标题\n\n普通正文,没有计划块。";
		assert.equal(transformPlanBlocks(md), md);
		assert.equal(transformPlanBlocks(null), null);
		assert.equal(transformPlanBlocks(undefined), undefined);
	});

	it("collapses a valid block into a one-line summary", () => {
		const out = transformPlanBlocks(`前文\n\n${VALID_BLOCK}\n\n后文`);
		assert.ok(!out.includes("```"), out);
		assert.ok(!out.includes("taskId"), out);
		assert.match(out, /前文/);
		assert.match(out, /后文/);
		assert.match(
			out,
			/> 📋 Policy Plan v4 · 2 步 · 修复技术拓扑图画布拥挤 · 已记录,等待审批/,
		);
	});

	it("collapses invalid JSON into the generic placeholder", () => {
		const out = transformPlanBlocks("```policy-plan\n{这不是合法 JSON}\n```");
		assert.ok(!out.includes("这不该出现"), out);
		assert.match(out, /> 📋 Policy Plan 已提交 · 等待审批/);
	});

	it("collapses blocks with unexpected shapes", () => {
		const out = transformPlanBlocks('```policy-plan\n"just a string"\n```');
		assert.match(out, /> 📋 Policy Plan 已提交 · 等待审批/);
	});

	it("collapses every block when several appear", () => {
		const out = transformPlanBlocks(`${VALID_BLOCK}\n\n${VALID_BLOCK}`);
		const summaries = out.split("\n").filter((l) => l.includes("📋 Policy Plan"));
		assert.equal(summaries.length, 2);
		assert.ok(!out.includes("```"));
	});

	it("is idempotent", () => {
		const once = transformPlanBlocks(VALID_BLOCK);
		assert.equal(transformPlanBlocks(once), once);
	});
});
