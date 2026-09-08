/**
 * plan-tool.test.js — policy_plan 工具与 validatePlanPayload 覆盖(0.40.0)。
 *
 *   A. validatePlanPayload:与 readPlanReport 同一套形状校验
 *      (taskId/planVersion 匹配、goal 非空、steps 1-30 且字段非空)。
 *   B. 工具 execute:有效载荷暂存 state.planToolReport;无效载荷报
 *      Error 且不暂存。
 *   C. readPlanReport 文本块回退路径回归(重构后仍工作)。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	readPlanReport,
	validatePlanPayload,
} from "../src/core/task-contract.js";
import { registerPlanTool } from "../extensions/policy-engine/plan-tool.js";
import { createState } from "../extensions/policy-engine/state.js";

const TASK = { id: "task-1", planVersion: 3, goal: "g" };

const VALID = {
	taskId: "task-1",
	planVersion: 3,
	goal: "修复部署",
	steps: [
		{ action: "改 compose", verification: "compose config 通过" },
		{ action: "沙箱验证", verification: "exit 0" },
	],
};

function captureTool() {
	let def;
	const pi = {
		registerTool(d) {
			def = d;
		},
	};
	return { def: () => def, pi };
}

describe("validatePlanPayload", () => {
	it("accepts a valid payload and normalizes steps", () => {
		const plan = validatePlanPayload(VALID, TASK);
		assert.ok(plan);
		assert.equal(plan.evidence, "assistant_reported");
		assert.equal(plan.steps.length, 2);
	});

	it("rejects taskId / planVersion mismatch", () => {
		assert.equal(validatePlanPayload({ ...VALID, taskId: "other" }, TASK), null);
		assert.equal(validatePlanPayload({ ...VALID, planVersion: 4 }, TASK), null);
	});

	it("rejects empty goal / empty or malformed steps", () => {
		assert.equal(validatePlanPayload({ ...VALID, goal: "  " }, TASK), null);
		assert.equal(validatePlanPayload({ ...VALID, steps: [] }, TASK), null);
		assert.equal(
			validatePlanPayload(
				{
					...VALID,
					steps: [{ action: "x", verification: "" }],
				},
				TASK,
			),
			null,
		);
	});

	it("rejects non-object payload / missing task", () => {
		assert.equal(validatePlanPayload(null, TASK), null);
		assert.equal(validatePlanPayload(VALID, null), null);
	});
});

describe("policy_plan tool", () => {
	it("stashes a valid report into state", async () => {
		const { def, pi } = captureTool();
		const state = createState();
		state.task = TASK;
		registerPlanTool(pi, { getState: () => state });
		const result = await def().execute("call-1", VALID);
		assert.ok(!result.content[0].text.startsWith("Error"));
		assert.equal(state.planToolReport.planVersion, 3);
		assert.equal(state.planToolReport.steps.length, 2);
	});

	it("rejects an invalid report without stashing", async () => {
		const { def, pi } = captureTool();
		const state = createState();
		state.task = TASK;
		registerPlanTool(pi, { getState: () => state });
		const result = await def().execute("call-1", { ...VALID, taskId: "nope" });
		assert.ok(result.content[0].text.startsWith("Error"));
		assert.equal(state.planToolReport, undefined);
	});
});

describe("readPlanReport fallback (regression)", () => {
	it("still parses the legacy text block", () => {
		const text = `计划如下:\n\n\`\`\`policy-plan\n${JSON.stringify(VALID)}\n\`\`\`\n`;
		const plan = readPlanReport(text, TASK);
		assert.ok(plan);
		assert.equal(plan.taskId, "task-1");
		assert.equal(plan.steps.length, 2);
	});
});
