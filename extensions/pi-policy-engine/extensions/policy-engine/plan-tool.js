/**
 * plan-tool.js — policy_plan 工具(0.40.0,0.41.0 卡片化)。
 *
 * 规划阶段的计划上报改为工具调用,取代在对话里打印整块 ```policy-plan JSON
 * (视觉噪音大且解析脆弱)。工具 execute 只校验并把结构化计划暂存到
 * state.planToolReport,由 lifecycle 的 turn_end 消费——与旧文本块走完全
 * 相同的转移语义(validatePlanPayload 共享校验,phase planning →
 * awaiting_approval)。文本块路径保留为向后兼容回退。
 *
 * 0.41.0:工具行从单行摘要升级为计划卡片——折叠一行
 * (`Policy Plan v4 · 2 步 · 目标首行 · ctrl+o 展开`),展开显示完整步骤与
 * 验证清单;行生成在 plan-card.js(纯函数,无 pi 依赖)。
 */

import { validatePlanPayload } from "../../src/core/task-contract.js";
import { planCardRows, planSummaryLine } from "./plan-card.js";

const PLAN_TOOL_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["taskId", "planVersion", "goal", "steps"],
	properties: {
		taskId: { type: "string", description: "当前任务契约的 taskId" },
		planVersion: { type: "number", description: "当前任务契约的 planVersion" },
		goal: { type: "string", description: "本次计划的目标(一句话)" },
		steps: {
			type: "array",
			minItems: 1,
			maxItems: 30,
			description:
				'计划步骤,{"action":"具体工作","verification":"检查与预期结果"}',
			items: {
				type: "object",
				additionalProperties: false,
				required: ["action", "verification"],
				properties: {
					action: { type: "string" },
					verification: { type: "string" },
				},
			},
		},
	},
};

/** pi 0.85 组件契约:render 返回 string[],invalidate 必须存在。 */
const toolLine = (render) => ({ render, invalidate: () => {} });

function firstLine(text) {
	return String(text ?? "").split("\n", 1)[0] ?? "";
}

export function registerPlanTool(pi, { getState }) {
	// 可选调用:极简宿主/旧版 pi 无 registerTool 时跳过注册,
	// 文本块回退路径仍然可用。
	pi.registerTool?.({
		name: "policy_plan",
		label: "Plan",
		description:
			"规划阶段产出具体计划后调用一次,记录计划供审批(代替打印 policy-plan JSON 块)。taskId/planVersion 必须与当前任务契约一致。",
		parameters: PLAN_TOOL_PARAMS,
		execute: async (_toolCallId, params) => {
			const state = getState();
			const plan = validatePlanPayload(params, state.task);
			if (!plan) {
				return {
					content: [
						{
							type: "text",
							text:
								"Error: 计划上报无效。taskId/planVersion 必须与当前任务契约一致;goal 为非空字符串;steps 为 1-30 项,每项含非空 action 与 verification。",
						},
					],
				};
			}
			state.planToolReport = plan;
			return {
				content: [
					{
						type: "text",
						text: `计划已记录(v${plan.planVersion},${plan.steps.length} 步),等待审批。`,
					},
				],
				details: { plan },
			};
		},
		renderCall(args, theme, context) {
			return toolLine((width) => {
				if (context?.expanded) {
					return planCardRows(args, width).map((row) =>
						theme ? theme.fg(row.tone, row.text) : row.text,
					);
				}
				const summary = planSummaryLine(args, width);
				return [theme ? theme.fg("accent", summary) : summary];
			});
		},
		renderResult(result, options, theme) {
			const text = firstLine(result?.content?.[0]?.text ?? "");
			const failed = text.startsWith("Error");
			const plan = result?.details?.plan;
			const expanded = options?.expanded === true;
			return toolLine((width) => {
				if (!failed && expanded && plan)
					return planCardRows(plan, width).map((row) =>
						theme ? theme.fg(row.tone, row.text) : row.text,
					);
				const label = failed ? text : `✓ ${text}`;
				const line = theme ? theme.fg(failed ? "error" : "success", label) : label;
				return [line.slice(0, width)];
			});
		},
	});
}
