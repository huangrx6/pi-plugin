// plan-approval-dialog.js — strict 计划就绪后的 Execute/Refine/Cancel 对话框
// (0.41.0)。
//
// 三条路全部复用既有转移语义,不旁路状态机:Execute/Cancel 发送规范短语,
// 由 resolvePlanResponse(src/core/approval.js)判定为 approve/cancel;
// Refine 用 ui.editor 收文本后作为普通用户消息进入 revise/discuss 路径。
// 规范短语在 tests/plan-approval-dialog.test.js 中对 resolvePlanResponse
// 锚定——改词可能被解析成 revise,导致"批准"按钮反而退回规划。
// 非交互宿主(ctx.hasUI 为假 / 无 ui.select)或配置关闭时静默跳过。

export const APPROVE_PHRASE = "批准,按计划执行";
export const CANCEL_PHRASE = "取消任务";
const REFINE_PROMPT = "计划需要调整:";

export async function offerPlanApprovalDialog(pi, ctx, cfg) {
  if (cfg?.planApprovalDialog === false) return;
  if (!ctx?.hasUI || typeof ctx?.ui?.select !== "function") return;
  const choice = await ctx.ui.select("Policy Plan 已就绪 — 等待审批", [
    "Execute the plan",
    "Refine the plan",
    "Cancel",
  ]);
  if (choice === "Execute the plan") {
    await pi.sendUserMessage?.(APPROVE_PHRASE, { deliverAs: "followUp" });
  } else if (choice === "Cancel") {
    await pi.sendUserMessage?.(CANCEL_PHRASE, { deliverAs: "followUp" });
  } else if (
    choice === "Refine the plan" &&
    typeof ctx?.ui?.editor === "function"
  ) {
    const refinement = await ctx.ui.editor(REFINE_PROMPT, REFINE_PROMPT);
    const text = String(refinement ?? "").trim();
    if (text) await pi.sendUserMessage?.(text, { deliverAs: "followUp" });
  }
}
