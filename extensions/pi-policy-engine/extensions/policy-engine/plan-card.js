// plan-card.js — policy_plan 工具行的计划卡片行生成(0.41.0)。
//
// 纯函数、无 pi 依赖:输入计划对象与终端宽度,输出 {text, tone} 行数组,
// 由 plan-tool.js 的 renderCall/renderResult 在渲染时用 theme.fg 上色。
// tone 语义与 activity.js 一致(accent/text/dim/success/error/warning)。
//
// 折叠:一行摘要 `Policy Plan v4 · 2 步 · 目标首行 · ctrl+o 展开`。
// 展开:标题 + goal 全文 + 编号步骤(action + ✓ 验证)+ 步数状态脚注。

import { displayWidth, wrapTerminalText } from "./terminal.js";

const STEP_GLYPHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09"];

function stepGlyph(index) {
  const n = Math.max(1, index + 1);
  return STEP_GLYPHS[n - 1] ?? String(n);
}

function firstLine(text) {
  return String(text ?? "").split("\n", 1)[0] ?? "";
}

/** Hang-indent wrap: first row prefixed, continuation rows aligned after it. */
function hangWrap(prefix, text, width) {
  const indent = displayWidth(prefix);
  const body = wrapTerminalText(text, Math.max(1, width - indent));
  const pad = " ".repeat(indent);
  return body.map((line, i) => (i === 0 ? prefix + line : pad + line));
}

function shapedPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length || typeof plan.goal !== "string" || !plan.goal.trim())
    return null;
  return {
    planVersion: plan.planVersion,
    goal: plan.goal,
    steps: steps
      .map((s) => ({
        action: typeof s?.action === "string" ? s.action : "",
        verification: typeof s?.verification === "string" ? s.verification : "",
      }))
      .filter((s) => s.action.trim() || s.verification.trim()),
  };
}

/** One-line collapsed summary; goal preview yields to the expand hint. */
export function planSummaryLine(plan, width) {
  const safeWidth = Math.max(1, width);
  const shaped = shapedPlan(plan);
  if (!shaped)
    return wrapTerminalText("Policy Plan · 等待参数…", safeWidth)[0] ?? "";
  const head = `Policy Plan v${shaped.planVersion ?? "?"} · ${shaped.steps.length} 步 · `;
  const hint = " · ctrl+o 展开";
  // 超窄终端连头部都放不下时,提示让位(被宿主折叠截断是可接受的)。
  const showHint = safeWidth - displayWidth(head) >= displayWidth(hint);
  const budget = Math.max(
    1,
    safeWidth - displayWidth(head) - (showHint ? displayWidth(hint) : 0),
  );
  const goal = wrapTerminalText(firstLine(shaped.goal), budget)[0] ?? "";
  // 终行用 wrapTerminalText 截断:slice 按码元切,CJK 宽字符会超列。
  return (
    wrapTerminalText(head + goal + (showHint ? hint : ""), safeWidth)[0] ?? ""
  );
}

/** Full card rows for the expanded view: header, steps, footer. */
export function planCardRows(plan, width) {
  const shaped = shapedPlan(plan);
  if (!shaped) return [{ text: "Policy Plan · 计划数据不可用", tone: "dim" }];
  const rows = [];
  const header = `Policy Plan v${shaped.planVersion ?? "?"}`;
  for (const line of hangWrap(`${header} · `, firstLine(shaped.goal), width))
    rows.push({ text: line, tone: "accent" });
  for (const restLine of shaped.goal.split("\n").slice(1)) {
    if (!restLine.trim()) continue;
    for (const text of wrapTerminalText(restLine, Math.max(1, width - 2)))
      rows.push({ text: `  ${text}`, tone: "text" });
  }
  shaped.steps.forEach((step, index) => {
    const glyph = stepGlyph(index);
    if (step.action.trim())
      for (const line of hangWrap(`  ${glyph}  `, step.action, width))
        rows.push({ text: line, tone: "text" });
    if (step.verification.trim())
      for (const line of hangWrap(`      ✓ `, step.verification, width))
        rows.push({ text: line, tone: "success" });
  });
  rows.push({
    text: `${shaped.steps.length} 步 · 等待审批`,
    tone: "dim",
  });
  return rows;
}
