const PROFILE_BY_TASK = {
  documentation: "documentation",
  debugging: "debugging",
  review: "review",
  research: "research",
  architecture: "architecture",
  coding: "coding",
};

export function chooseWorkflow(classification, requestedMode = "auto") {
  if (
    ["off", "quick", "standard", "strict"].includes(requestedMode) &&
    requestedMode !== "auto"
  ) {
    return requestedMode;
  }

  // Read-only intent never needs the strict approval cycle — downgrade to a
  // standard (or quick) read-only flow. "unclear" keeps full rigor: we can't
  // prove it won't mutate.
  if (classification.executionIntent === "read-only") {
    if (classification.risk === "high") return "standard";
    return classification.taskType === "research" ||
      classification.taskType === "review"
      ? "quick"
      : "standard";
  }

  if (classification.risk === "high") return "strict";
  if (classification.risk === "low") return "quick";
  return "standard";
}

export function chooseProfile(classification, requestedProfile = "auto") {
  if (requestedProfile && requestedProfile !== "auto") return requestedProfile;
  return PROFILE_BY_TASK[classification.taskType] ?? "coding";
}

export function modelPolicyId(model) {
  const provider = String(model?.provider ?? "").toLowerCase();
  const id = String(model?.id ?? model?.name ?? "").toLowerCase();
  const all = `${provider}/${id}`;

  if (
    all.includes("minimax") &&
    (all.includes("m3") || all.includes("minimax-m3"))
  ) {
    return "model.minimax-m3";
  }
  if (all.includes("deepseek")) return "model.deepseek";
  return null;
}

export function buildDecision({ classification, mode, profile, model }) {
  const workflow = chooseWorkflow(classification, mode);
  const selectedProfile = chooseProfile(classification, profile);
  const modelPolicy = modelPolicyId(model);

  return {
    taskType: classification.taskType,
    risk: classification.risk,
    confidence: classification.confidence,
    executionIntent: classification.executionIntent,
    domains: classification.domains,
    concerns: classification.concerns,
    workflow,
    profile: selectedProfile,
    modelPolicy,
    reasons: classification.reasons,
  };
}
