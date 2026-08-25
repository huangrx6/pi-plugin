// Human-readable formatters for decisions and status rows. Pure functions;
// consumed by commands.js and lifecycle.js.

/**
 * Render a `/policy test-guard` result as human-readable text.
 */
export function formatGuardPreview(result, { gate, command }) {
  const lines = [
    `# Guard preview (gate: ${gate ?? "?"})`,
    "",
    `command: ${command ?? ""}`,
    `would block: ${result.wouldBlock ? "yes" : "no"}`,
  ];
  if (result.wouldBlock) {
    lines.push(`category: ${result.category ?? "?"}`);
    lines.push(`label: ${result.label ?? "?"}`);
    lines.push(`segment: ${result.segment ?? ""}`);
    lines.push(`reason: ${result.reason ?? ""}`);
  } else if (gate === "off") {
    lines.push("(gate is off — nothing is mechanically blocked)");
  } else if (gate === "soft") {
    lines.push(
      "(soft gate blocks direct mutation tools like write / edit; shell commands need hard gate to be blocked)",
    );
  } else {
    lines.push("(no built-in or custom pattern matched this command)");
  }
  return lines.join("\n");
}

export function formatHistory(entries, n = 5) {
  if (!entries || entries.length === 0) {
    return "No routing history yet. Use /policy preview <prompt> to dry-run, or send a prompt to record one.";
  }
  const limit = Math.min(Math.max(1, Number(n) || 5), entries.length);
  const lines = [`# Routing history (last ${limit} of ${entries.length})`, ""];
  // Walk the array backwards without .reverse() to avoid mutating a slice.
  for (
    let i = entries.length - 1, shown = 0;
    i >= 0 && shown < limit;
    i--, shown++
  ) {
    const e = entries[i];
    const idx = i + 1; // 1-based chronological numbering
    const time = new Date(e.ts).toISOString().slice(11, 19);
    const conf =
      typeof e.confidence === "number" ? e.confidence.toFixed(2) : "?";
    const taskRisk =
      e.task && e.risk ? `${e.task} / ${e.risk}` : (e.task ?? "?");
    lines.push(
      `${idx}. [${time}] ${e.source ?? "decide"}  ${e.workflow}  (${taskRisk}, conf=${conf})`,
    );
    lines.push(`     prompt: ${e.prompt ?? ""}`);
  }
  return lines.join("\n");
}

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
 * Render the resolved effective config as a human-readable dump. The
 * config object already has defaults < global < project < runtime merged
 * in by `mergeConfig`, so this shows the actual values in force.
 */
export function formatConfig(config) {
  const lines = ["# Resolved policy-engine config", ""];
  lines.push("routing");
  lines.push(`  mode: ${config.mode ?? "auto"}`);
  lines.push(`  gate: ${config.gate ?? "soft"}`);
  lines.push(`  profile: ${config.profile ?? "auto"}`);
  lines.push(`  showStatus: ${config.showStatus !== false}`);
  lines.push(`  domainHints: ${JSON.stringify(config.domainHints ?? [])}`);
  lines.push("");
  lines.push("policies");
  lines.push(`  projectPolicyMaxFiles: ${config.projectPolicyMaxFiles ?? 12}`);
  lines.push(
    `  projectPolicyMaxBytes: ${config.projectPolicyMaxBytes ?? 24000}`,
  );
  lines.push(`  policyMaxBytes: ${config.policyMaxBytes ?? 24000}`);
  lines.push(
    `  includePolicies: ${JSON.stringify(config.includePolicies ?? [])}`,
  );
  lines.push(
    `  excludePolicies: ${JSON.stringify(config.excludePolicies ?? [])}`,
  );
  const customCount = Array.isArray(config?.guard?.customPatterns)
    ? config.guard.customPatterns.length
    : 0;
  lines.push("");
  lines.push("guard");
  lines.push(
    `  enabledCategories: ${JSON.stringify(config.guard?.enabledCategories ?? "(default: all)")}`,
  );
  lines.push(
    `  disabledCategories: ${JSON.stringify(config.guard?.disabledCategories ?? [])}`,
  );
  lines.push(`  customPatterns: ${customCount} configured`);
  lines.push("");
  lines.push("semanticFallback");
  const sf = config.semanticFallback ?? {};
  lines.push(`  enabled: ${sf.enabled === true}`);
  if (sf.enabled === true) {
    lines.push(`  endpoint: ${sf.endpoint ?? "(default)"}`);
    lines.push(`  model: ${sf.model ?? "(default)"}`);
    lines.push(`  apiKeyEnvVar: ${sf.apiKeyEnvVar ?? "(default)"}`);
    lines.push(`  confidenceThreshold: ${sf.confidenceThreshold ?? 0.7}`);
    lines.push(`  timeoutMs: ${sf.timeoutMs ?? 4000}`);
  }
  return lines.join("\n");
}

/**
 * Render a `/policy preview` result as human-readable text. Used both for
 * `ctx.ui.notify()` and as a stable format for tests.
 */
export function formatPreview(preview) {
  if (!preview) return "No preview available.";
  const {
    decision,
    classification,
    policies,
    projectPolicies,
    truncated,
    wouldRequireApproval,
    stats,
  } = preview;
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
  lines.push(
    "",
    `project policies (${stats.projectCount} loaded, ${stats.projectBytes} bytes):`,
  );
  for (const p of projectPolicies) lines.push(`  - ${p.id}`);
  if (classification?.reasons?.length) {
    lines.push("", "classification reasons:");
    for (const reason of classification.reasons) lines.push(`  - ${reason}`);
  }
  return lines.join("\n");
}
