// Human-readable formatters for decisions and status rows. Pure functions;
// consumed by commands.js and lifecycle.js.

function previewPhaseLabel(workflow) {
  if (workflow === "off") return "idle";
  if (workflow === "strict") return "planning";
  return "executing";
}

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

/**
 * Render a `/policy preview` result as human-readable text. Used both for
 * `ctx.ui.notify()` and as a stable format for tests.
 */
export function formatPreview(preview) {
  if (!preview) return "No preview available.";
  const { decision, classification, policies, projectPolicies, truncated, wouldRequireApproval, stats } = preview;
  const lines = [
    "# Policy preview (dry run; nothing is executed)",
    "",
    `task: ${decision.taskType}`,
    `risk: ${decision.risk}`,
    `confidence: ${decision.confidence}`,
    `domains: ${(decision.domains ?? []).join(", ") || "none"}`,
    `workflow: ${decision.workflow}`,
    `phase: ${previewPhaseLabel(decision.workflow)}`,
    `profile: ${decision.profile}`,
    `gate: ${decision.gate}`,
    `model policy: ${decision.modelPolicy ?? "default"}`,
    `would require approval: ${wouldRequireApproval ? "yes" : "no"}`,
    "",
    `built-in policies (${stats.builtInCount} loaded, ${stats.builtInBytes} bytes / ${stats.budget} budget = ${stats.budgetUsedPct}%):`,
  ];
  for (const p of policies) lines.push(`  - ${p.id}`);
  if (truncated.length > 0) {
    lines.push(`truncated by byte budget:`);
    for (const id of truncated) lines.push(`  - ${id}`);
  }
  lines.push("", `project policies (${stats.projectCount} loaded, ${stats.projectBytes} bytes):`);
  for (const p of projectPolicies) lines.push(`  - ${p.id}`);
  if (classification?.reasons?.length) {
    lines.push("", "classification reasons:");
    for (const reason of classification.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}
