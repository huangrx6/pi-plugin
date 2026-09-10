// plan-approval-dialog.js — strict 计划就绪后的 Execute/Refine/Cancel 对话框
// (0.41.0)。
//
// 三条路全部复用既有转移语义，不旁路状态机：Execute/Cancel 发送规范短语，
// 由 resolvePlanResponse(src/core/approval.js)判定为 approve/cancel；
// Refine 用 ui.editor 收文本后作为普通用户消息进入 revise/discuss 路径。
// 规范短语在 tests/plan-approval-dialog.test.js 中对 resolvePlanResponse
// 锚定——改词可能被解析成 revise，导致"批准"按钮反而退回规划。
// 非交互宿主（ctx.hasUI 为假 / 无 ui.select）或配置关闭时静默跳过。
//
// 0.42.0：安装官方 plan-mode 扩展时，policy-engine 主动让位
// （isPlanModeActive() 双路探测）——避免 dialog 双触发。用户可
// 手动选 plan-mode 的 Execute / Stay / Refine 接管审批。

export const APPROVE_PHRASE = "批准,按计划执行";
export const CANCEL_PHRASE = "取消任务";
const REFINE_PROMPT = "计划需要调整:";

/**
 * 探测官方 plan-mode 扩展是否在活跃（0.42.0+）。
 *
 * 探测策略：扫 pi.getAllTools() 与 pi.getCommands() 的 sourceInfo，
 * 找到 source === "extension"（非 builtin / 非 sdk）且 name 匹配
 * plan 模式特征的 entry。
 *
 * 该函数是友好型"让位"探测，错误探出（getAllTools 未实现或抛错）
 * 一律返回 false：宁可双重弹框，也不能误判让位导致审批路径丢。
 */
export function isPlanModeActive(pi) {
  if (!pi) return false;
  try {
    const all = pi.getAllTools?.() ?? [];
    if (
      all.some((t) => {
        const info = t?.sourceInfo;
        const src = info?.source;
        return (
          src !== undefined &&
          src !== "builtin" &&
          src !== "sdk" &&
          /plan/i.test(String(t?.name ?? ""))
        );
      })
    ) {
      return true;
    }
    const cmds = pi.getCommands?.() ?? [];
    if (
      cmds.some((c) => {
        const info = c?.sourceInfo;
        const src = info?.source;
        return (
          src !== undefined &&
          src !== "builtin" &&
          src !== "sdk" &&
          String(c?.name ?? "") === "plan"
        );
      })
    ) {
      return true;
    }
  } catch {
    /* probe 失败 = 假设未在活跃（保守不让位） */
  }
  return false;
}

export async function offerPlanApprovalDialog(pi, ctx, cfg) {
  if (cfg?.planApprovalDialog === false) return;
  if (!ctx?.hasUI || typeof ctx?.ui?.select !== "function") return;
  // 0.42.0：探测到 plan-mode 扩展在活跃时让位，避免 dialog 双触发
  if (isPlanModeActive(pi)) {
    ctx.ui.notify?.(
      "Policy 计划已就绪；plan-mode 扩展在活跃，审批由其接管。",
      "info",
    );
    return;
  }
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
