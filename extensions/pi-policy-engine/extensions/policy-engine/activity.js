import { createHash } from "node:crypto";
import { sanitizeTerminalText, wrapTerminalText } from "./terminal.js";

export const ACTIVITY_TYPE = "policy-engine-activity";
const rigors = {
  quick: "轻量流程",
  standard: "标准流程",
  strict: "严格流程",
  off: "已关闭",
};
const tasks = {
  debugging: "故障排查",
  coding: "代码任务",
  conversation: "普通对话",
  documentation: "文档调整",
  review: "项目审查",
  research: "调研",
  architecture: "架构设计",
};
const policies = {
  "core.evidence-priority": "以证据为依据",
  "core.constraint-retention": "保留用户约束",
  "core.verification": "验证变更结果",
  "intent.read-only": "仅检查和分析",
  "intent.mutate": "按授权执行变更",
  "intent.unclear": "澄清执行意图",
  "intent.contextual": "当前模型结合完整对话判断",
  "behavior.execution-discipline": "持续执行并跟踪结果",
  "behavior.minimal-change": "控制变更范围",
  "behavior.context-hygiene": "管理上下文证据",
  "behavior.tool-discipline": "按工具契约执行",
  "rigor.quick": "检查 → 修改 → 验证",
  "rigor.standard": "明确任务 → 检查 → 计划 → 执行 → 验证",
  "rigor.strict-review": "严格只读审查",
  "rigor.strict-plan": "先制定计划并等待审批",
  "rigor.strict-execute": "按批准的计划分步执行",
  "flow.debug-first": "先复现和定位原因",
  "flow.review-first": "优先审查问题与风险",
  "flow.research-first": "先收集和核对资料",
  "domain.documentation": "文档规范",
  "domain.database": "数据库变更约束",
  "domain.kubernetes": "Kubernetes 操作约束",
  "domain.backend": "后端开发约束",
  "domain.frontend": "前端开发约束",
  "concern.security": "安全检查要求",
  "concern.production": "生产环境变更约束",
  "model.minimax-m3": "MiniMax 模型指令适配",
  "model.deepseek": "DeepSeek 模型指令适配",
};

export function activitySnapshot(decision, phase, injected = "") {
  const data = structuredClone(decision ?? { rigor: "off" });
  const modelRecognition =
    data.recognition?.source === "agent" &&
    data.recognition?.reason === "contextual";
  const recognitionBlocked = data.preflightBlocked === true;
  const policyUnchanged = data.recognition?.policyUnchanged === true;
  const next = recognitionBlocked
    ? "先重试识别或检查 recognition 配置；本轮不会执行变更。"
    : !injected
      ? "本轮没有追加策略指令。"
    : phase === "planning"
      ? "先生成计划，完成后等待你确认。"
      : phase === "awaiting_approval"
        ? "等待你批准计划；可以继续提问或修改约束。"
        : "模型继续处理当前任务，无需额外操作。";
  return deepFreeze({
    decision: data,
    phase,
    injected,
    next,
    summary: injected
      ? recognitionBlocked
        ? "意图识别失败 · 本轮已阻止策略执行"
        : policyUnchanged
          ? `策略已复用 · ${rigors[data.rigor] ?? data.rigor ?? "模型选择流程"} · 当前模型确认策略未变化`
          : modelRecognition
            ? `策略已加载 · ${rigors[data.rigor] ?? data.rigor ?? "模型选择流程"} · 当前模型已识别并选择策略`
            : `策略已加载 · ${rigors[data.rigor] ?? data.rigor ?? "自动流程"} · ${{ "read-only": "只读", mutate: "修改", unclear: "需要澄清" }[data.executionIntent] ?? "需要澄清"}`
      : "本轮未注入策略",
    // Exclude reason wording and timestamps: identical applied instructions do
    // not create a new transcript entry on every follow-up.
    fingerprint: createHash("sha256")
      .update(`${phase}\n${injected}`)
      .digest("hex"),
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function activityText(activity) {
  if (!activity) return "尚未处理请求。发送任务后，这里会说明本次策略行为。";
  const d = activity.decision ?? {};
  const applied = activity.injected
    ? (d.loadedPolicies ?? []).map((id) => `  · ${policies[id] ?? id}`)
    : [];
  return sanitizeTerminalText(
    [
      activity.summary,
      d.preflightBlocked
        ? `判断方式：模型识别未成功（${d.recognition?.reason ?? "unknown"}），本轮未使用本地规则继续执行。`
        : d.recognition?.source === "agent" &&
            d.recognition?.reason === "contextual"
          ? `判断方式：当前模型使用完整对话完成意图识别，并据此选择本轮策略。`
          : `判断方式：识别为${tasks[d.taskType] ?? d.taskType ?? "未分类"}；风险 ${d.risk ?? "未知"}。`,
      ...(d.reasons?.length
        ? ["触发依据：", ...d.reasons.map((reason) => `  ${reason}`)]
        : []),
      "实际追加的要求：",
      ...(applied.length ? applied : ["  无"]),
      ...(d.truncatedPolicies?.length
        ? [`预算不足，未注入：${d.truncatedPolicies.join("、")}`]
        : []),
      ...(d.missingPolicies?.length
        ? [`未找到：${d.missingPolicies.join("、")}`]
        : []),
      `当时安排：${activity.next}`,
      "这些是已提供给模型的指令；执行结果需另行验证。",
      "原文：/policy injected",
    ].join("\n"),
  );
}

export function activityRows(activity, expanded, width) {
  const fallback = {
    decision: {},
    summary: "策略记录不可用",
    injected: "",
    next: "无可用记录。",
  };
  const safe =
    activity?.decision && typeof activity?.summary === "string"
      ? activity
      : fallback;
  const text = expanded
    ? activityText(safe)
    : `${safe.summary} · /policy 查看说明`;
  const logicalRows = text.split("\n");
  return logicalRows.flatMap((line, index) => {
    const tone =
      index === 0
        ? safe.injected
          ? "accent"
          : "muted"
        : /^(预算不足，未注入|未找到)/.test(line)
          ? "warning"
          : /^(触发依据|实际追加的要求)：/.test(line) ||
              /^为什么：|^当时安排：/.test(line)
            ? "text"
            : "dim";
    return wrapTerminalText(line, width).map((text) => ({ text, tone }));
  });
}

export function publishActivity(
  pi,
  state,
  ctx,
  injected,
  decision = state.lastDecision,
) {
  const snapshot = activitySnapshot(decision, state.phase, injected);
  const changed = state.lastActivity?.fingerprint !== snapshot.fingerprint;
  state.lastActivity = snapshot;
  if (!changed) return;
  try {
    if (typeof pi.appendEntry === "function")
      pi.appendEntry(ACTIVITY_TYPE, snapshot);
    if (
      typeof pi.appendEntry !== "function" ||
      typeof pi.registerEntryRenderer !== "function"
    )
      ctx?.ui?.notify?.(
        sanitizeTerminalText(`${snapshot.summary} · /policy why 查看说明`),
        "info",
      );
  } catch {
    // Presentation is best effort; it must not prevent the actual policy block
    // from reaching the model. The in-memory explanation remains queryable.
  }
}

export function phaseText(phase) {
  return (
    {
      idle: "当前轮已结束，等待新输入。",
      planning: "正在生成计划。",
      awaiting_approval: "等待你确认计划；可以批准、提问或修改约束。",
      executing: "当前任务执行中。",
    }[phase] ?? "尚未开始。"
  );
}

export function restoreActivity(entries) {
  const branch = Array.from(entries);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    const data = entry?.data;
    if (
      entry?.type === "custom" &&
      entry.customType === ACTIVITY_TYPE &&
      data?.decision &&
      typeof data.summary === "string" &&
      typeof data.injected === "string" &&
      typeof data.next === "string" &&
      typeof data.fingerprint === "string"
    )
      return deepFreeze(structuredClone(data));
  }
  return null;
}
