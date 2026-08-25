// Human-readable formatters for decisions and status rows. Pure functions;
// consumed by commands.js and lifecycle.js.
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
      `${idx}. [${time}] ${e.source ?? "decide"}  ${e.rigor ?? e.workflow ?? "?"}  (${taskRisk}, conf=${conf})`,
    );
    lines.push(`     prompt: ${e.prompt ?? ""}`);
  }
  return lines.join("\n");
}

function previewPhaseLabel(rigor) {
  if (rigor === "off") return "idle";
  if (rigor === "strict") return "planning";
  return "executing";
}

export function formatDecision(decision, phase) {
  if (!decision) return "No policy decision has been made in this session yet.";
  const lines = [
    `rigor: ${decision.rigor}`,
    `flow: ${decision.flow ?? "default"}`,
    `phase: ${phase}`,
    `task: ${decision.taskType}`,
    `risk: ${decision.risk}`,
    `profile: ${decision.profile}`,
    `domains: ${(decision.domains ?? []).join(", ") || "none"}`,
    `concerns: ${(decision.concerns ?? []).join(", ") || "none"}`,
    `model policy: ${decision.modelPolicy ?? "default"}`,
    `confidence: ${decision.confidence}`,
  ];
  if (Number.isFinite(decision.policyBytes)) {
    const usedKb = Math.round(decision.policyBytes / 102.4) / 10;
    const totalKb = Math.round((decision.policyBudget ?? 24000) / 102.4) / 10;
    lines.push(`policy budget: ${usedKb} KB / ${totalKb} KB`);
  }
  if (decision.loadedPolicies?.length) {
    lines.push("loaded policies:");
    for (const id of decision.loadedPolicies) lines.push(`- ${id}`);
  }
  if (decision.truncatedPolicies?.length) {
    lines.push("truncated by byte budget:");
    for (const id of decision.truncatedPolicies) lines.push(`- ${id}`);
  }
  if (decision.missingPolicies?.length) {
    lines.push("unavailable (not in manifest — check includePolicies):");
    for (const id of decision.missingPolicies) lines.push(`- ${id}`);
  }
  if (decision.droppedProjectPolicies?.length) {
    lines.push("project policies dropped:");
    for (const d of decision.droppedProjectPolicies) {
      lines.push(`- ${d.id} (${d.reason})`);
    }
  }
  if (decision.reasons?.length) {
    lines.push("reasons:");
    for (const reason of decision.reasons) lines.push(`- ${reason}`);
  }
  return lines.join("\n");
}

export function formatStatusSummary({ config, phase, model }) {
  return [
    `mode: ${config.mode ?? "auto"}`,
    `profile: ${config.profile ?? "auto"}`,
    `phase: ${phase}`,
    `awaiting approval: ${phase === "awaiting_approval" ? "yes" : "no"}`,
    `model: ${model}`,
  ].join("\n");
}

/**
 * Render the resolved effective config as a human-readable dump. The
 * config object already has defaults < global < project < runtime merged
 * in by `mergeConfig`, so this shows the actual values in force.
 */
/**
 * Render a `/policy diff` result. Shows the two prompts + their decisions
 * side by side, then a "Differences" section listing fields that differ.
 * Returns a graceful message when both prompts route identically.
 */
export function formatDiff({
  leftPrompt,
  left,
  rightPrompt,
  right,
  differences,
}) {
  const lines = ["# Policy diff", ""];
  lines.push(`LEFT : ${leftPrompt ?? ""}`);
  lines.push(`RIGHT: ${rightPrompt ?? ""}`);
  lines.push("");
  lines.push("LEFT");
  lines.push(`  rigor: ${left?.decision?.rigor ?? "?"}`);
  lines.push(`  flow: ${left?.decision?.flow ?? "default"}`);
  lines.push(
    `  task / risk: ${left?.decision?.taskType ?? "?"} / ${left?.decision?.risk ?? "?"}`,
  );
  lines.push(
    `  domains: ${(left?.decision?.domains ?? []).join(",") || "none"}`,
  );
  lines.push(`  confidence: ${left?.decision?.confidence ?? "?"}`);
  lines.push(`  profile: ${left?.decision?.profile ?? "?"}`);
  lines.push(
    `  would require approval: ${left?.wouldRequireApproval ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push("RIGHT");
  lines.push(`  rigor: ${right?.decision?.rigor ?? "?"}`);
  lines.push(`  flow: ${right?.decision?.flow ?? "default"}`);
  lines.push(
    `  task / risk: ${right?.decision?.taskType ?? "?"} / ${right?.decision?.risk ?? "?"}`,
  );
  lines.push(
    `  domains: ${(right?.decision?.domains ?? []).join(",") || "none"}`,
  );
  lines.push(`  confidence: ${right?.decision?.confidence ?? "?"}`);
  lines.push(`  profile: ${right?.decision?.profile ?? "?"}`);
  lines.push(
    `  would require approval: ${right?.wouldRequireApproval ? "yes" : "no"}`,
  );
  lines.push("");
  if (!differences || differences.length === 0) {
    lines.push("Differences: (none — both prompts route identically)");
  } else {
    lines.push(`Differences (${differences.length}):`);
    for (const d of differences) {
      lines.push(
        `  ${d.field}: ${formatDiffValue(d.left)}  →  ${formatDiffValue(d.right)}`,
      );
    }
  }
  return lines.join("\n");
}

function formatDiffValue(value) {
  if (value === undefined) return "(unset)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * Render a `/policy validate` result. Groups issues by severity and
 * prints a one-line verdict at the top.
 */
export function formatValidation(result) {
  if (!result) return "No validation result.";
  const errors = (result.issues ?? []).filter((i) => i.severity === "error");
  const warnings = (result.issues ?? []).filter(
    (i) => i.severity === "warning",
  );
  let verdict;
  if (!result.ok) {
    const suffix = errors.length === 1 ? "" : "s";
    verdict = `FAIL (${errors.length} error${suffix})`;
  } else if (warnings.length > 0) {
    verdict = "OK (with warnings)";
  } else {
    verdict = "OK";
  }
  const lines = [`# Validation: ${verdict}`, ""];
  if (errors.length > 0) {
    lines.push(`## Errors (${errors.length})`);
    for (const e of errors) lines.push(`  [error]   ${e.message}`);
    lines.push("");
  }
  if (warnings.length > 0) {
    lines.push(`## Warnings (${warnings.length})`);
    for (const w of warnings) lines.push(`  [warning] ${w.message}`);
    lines.push("");
  }
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("No issues found.");
  }
  return lines.join("\n");
}

export function formatConfig(config) {
  const lines = ["# Resolved policy-engine config", ""];
  lines.push("routing");
  lines.push(`  mode: ${config.mode ?? "auto"}`);
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
    `execution intent: ${decision.executionIntent ?? "unclear"}`,
    `domains: ${(decision.domains ?? []).join(", ") || "none"}`,
    `concerns: ${(decision.concerns ?? []).join(", ") || "none"}`,
    `rigor: ${decision.rigor}`,
    `flow: ${decision.flow ?? "default"}`,
    `phase: ${previewPhaseLabel(decision.rigor)}`,
    `profile: ${decision.profile}`,
    `model policy: ${decision.modelPolicy ?? "default"}`,
    `would require approval: ${wouldRequireApproval ? "yes" : "no"}`,
    "",
    `policies (built-in ${stats.builtInCount} + project ${stats.projectCount}, ${stats.builtInBytes + stats.projectBytes} bytes / ${stats.budget} total budget = ${stats.budgetUsedPct}%):`,
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
