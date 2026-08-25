// Human-readable formatters for decisions and status rows. Pure functions;
// consumed by commands.js and lifecycle.js.

export function formatDecision(decision, phase) {
  if (!decision) return "No policy decision has been made in this session yet.";
  const lines = [
    `workflow: ${decision.workflow}`,
    `phase: ${phase}`,
    `task: ${decision.taskType}`,
    `risk: ${decision.risk}`,
    `profile: ${decision.profile}`,
    `gate: ${decision.gate}`,
    `domains: ${(decision.domains ?? []).join(", ") || "none"}`,
    `model policy: ${decision.modelPolicy ?? "default"}`,
    `confidence: ${decision.confidence}`,
  ];
  if (decision.loadedPolicies?.length) {
    lines.push("loaded policies:");
    for (const id of decision.loadedPolicies) lines.push(`- ${id}`);
  }
  if (decision.truncatedPolicies?.length) {
    lines.push("truncated by byte budget:");
    for (const id of decision.truncatedPolicies) lines.push(`- ${id}`);
  }
  if (decision.reasons?.length) {
    lines.push("reasons:");
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
  }
  return lines.join("\n");
}

export function formatStatusSummary({ config, phase, pendingApproval, model }) {
  return [
    `mode: ${config.mode ?? "auto"}`,
    `gate: ${config.gate ?? "soft"}`,
    `profile: ${config.profile ?? "auto"}`,
    `phase: ${phase}`,
    `pending approval: ${pendingApproval ? "yes" : "no"}`,
    `model: ${model}`,
  ].join("\n");
}
