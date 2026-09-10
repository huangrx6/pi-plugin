// plan-display.js — policy-plan 文本块的显示层折叠(0.41.0)。
//
// 0.40.0 起,计划上报的正道是 policy_plan 工具;但模型偶发不遵守、或旧
// 会话恢复时,助手文本里仍可能出现 ```policy-plan JSON 块。本模块在
// 「显示层」把这种块折叠为一行紧凑摘要,原始 session/LLM context 不变
// (pi.registerMarkdownTransformer 的契约)。纯函数、无 pi 依赖。
//
// 与 readPlanReport(task-contract.js)共用同一 fence 形状;解析失败也照
// 样折叠——原始 JSON 永远不该出现在屏幕上。

const PLAN_FENCE_RE = /```policy-plan[ \t]*\n([\s\S]*?)\n```/g;
const GOAL_PREVIEW_WIDTH = 40;

function firstLine(text) {
  return String(text ?? "").split("\n", 1)[0] ?? "";
}

function summarize(body) {
  try {
    const parsed = JSON.parse(String(body ?? ""));
    if (parsed && typeof parsed === "object") {
      const steps = Array.isArray(parsed.steps) ? parsed.steps.length : null;
      const goal =
        typeof parsed.goal === "string" ? firstLine(parsed.goal) : "";
      const version =
        parsed.planVersion === undefined ? "?" : String(parsed.planVersion);
      if (steps !== null || goal) {
        const goalPart = goal ? ` · ${goal.slice(0, GOAL_PREVIEW_WIDTH)}` : "";
        return `> 📋 Policy Plan v${version}${steps === null ? "" : ` · ${steps} 步`}${goalPart} · 已记录,等待审批`;
      }
    }
  } catch {
    // fall through to the generic placeholder
  }
  return "> 📋 Policy Plan 已提交 · 原块不可解析,已折叠为提示";
}

/**
 * Replace every ```policy-plan fenced block in assistant markdown with a
 * one-line summary. Idempotent; input without fences is returned as-is.
 */
export function transformPlanBlocks(markdown) {
  if (typeof markdown !== "string" || !markdown.includes("```policy-plan"))
    return markdown;
  return markdown.replace(PLAN_FENCE_RE, (_match, body) => summarize(body));
}
