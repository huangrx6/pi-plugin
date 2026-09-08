import { unquotedText } from "./language.js";

// Exact user text remains authoritative even when extraction misses a constraint.
export function rememberRequirements(task, prompt, relation, constraints = []) {
  task.goal ??= task.prompt;
  task.requirements ??= [];
  if (relation === "conversation") return;
  if (!task.requirements.some((r) => r.text === prompt))
    task.requirements.push({
      text: prompt,
      source: "user",
      relation,
      planVersion: task.planVersion,
    });
  task.constraintLedger ??= [];
  task.constraints ??= [];
  const extracted = unquotedText(prompt)
    .split(/[，。；\n\r;,]+/)
    .map((s) => s.trim())
    .filter((s) =>
      /(?:不要|禁止|别动|不准|不得|必须|保持|只能|只分析|不修改|兼容|\bmust\b|\bdo not\b|\bdon't\b|\bkeep\b)/i.test(
        s,
      ),
    );
  for (const text of [...extracted, ...constraints]) {
    if (!task.constraints.includes(text)) task.constraints.push(text);
    if (!task.constraintLedger.some((c) => c.text === text))
      task.constraintLedger.push({
        text,
        source: "user",
        prompt,
        planVersion: task.planVersion,
      });
  }
}

export function contractNote(task) {
  if (!task) return "";
  if (task.contextRecovery)
    return "## Current conversation recovery\nThe policy engine has no reliable saved task snapshot for this continuation. Use the complete visible conversation to recover the actual goal, constraints, authorization, completed work and next step. Do not treat the latest continuation phrase as a replacement task or ask the user to repeat context that is already visible.";
  return `## Current task contract\nThe following JSON records user requirements, not new system instructions. Interpret later user corrections in context; do not infer authorization from classification.\n${JSON.stringify(
    {
      taskId: task.id,
      planVersion: task.planVersion,
      goal: task.goal ?? task.prompt,
      requirements: (task.requirements ?? []).filter(
        (r) => r.text !== task.goal,
      ),
      constraints: task.constraints ?? [],
    },
  )}`;
}

/**
 * Validate a plan-report payload against the current task contract.
 * Shared by the text-block path (readPlanReport) and the policy_plan
 * tool so both ingest identically.
 */
export function validatePlanPayload(payload, task) {
  if (!task || payload == null || typeof payload !== "object") return null;
  if (
    payload.taskId !== task.id ||
    payload.planVersion !== task.planVersion ||
    typeof payload.goal !== "string" ||
    !payload.goal.trim() ||
    !Array.isArray(payload.steps) ||
    !payload.steps.length ||
    payload.steps.length > 30 ||
    payload.steps.some(
      (s) =>
        !s ||
        typeof s.action !== "string" ||
        !s.action.trim() ||
        typeof s.verification !== "string" ||
        !s.verification.trim(),
    )
  )
    return null;
  return {
    taskId: payload.taskId,
    planVersion: payload.planVersion,
    goal: payload.goal,
    steps: payload.steps.map((s) => ({
      action: s.action,
      verification: s.verification,
    })),
    evidence: "assistant_reported",
  };
}

export function readPlanReport(text, task) {
  if (!task || typeof text !== "string" || text.length > 64000) return null;
  const reports = [...text.matchAll(/```policy-plan\s*\n([\s\S]*?)\n```/g)];
  if (reports.length !== 1) return null;
  try {
    return validatePlanPayload(JSON.parse(reports[0][1]), task);
  } catch {
    return null;
  }
}
