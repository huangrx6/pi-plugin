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

export function readPlanReport(text, task) {
  if (!task || typeof text !== "string" || text.length > 64000) return null;
  const reports = [...text.matchAll(/```policy-plan\s*\n([\s\S]*?)\n```/g)];
  if (reports.length !== 1) return null;
  try {
    const p = JSON.parse(reports[0][1]);
    if (
      p.taskId !== task.id ||
      p.planVersion !== task.planVersion ||
      typeof p.goal !== "string" ||
      !p.goal.trim() ||
      !Array.isArray(p.steps) ||
      !p.steps.length ||
      p.steps.length > 30 ||
      p.steps.some(
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
      taskId: p.taskId,
      planVersion: p.planVersion,
      goal: p.goal,
      steps: p.steps.map((s) => ({
        action: s.action,
        verification: s.verification,
      })),
      evidence: "assistant_reported",
    };
  } catch {
    return null;
  }
}
