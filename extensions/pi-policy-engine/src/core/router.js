// Decision builder: rigor (how strict) + flow (how to work) + profile.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROFILE_BY_TASK = {
  documentation: "documentation",
  debugging: "debugging",
  review: "review",
  research: "research",
  architecture: "architecture",
  coding: "coding",
};

// Flow (v0.19): HOW the task is worked, derived from task type. Independent
// of rigor (how strictly): debug-first pairs with quick/standard/strict alike.
const FLOW_BY_TASK = {
  debugging: "debug-first",
  review: "review-first",
  research: "research-first",
};

// Fallback rules when config/models.json is absent. Kept in sync with the
// shipped file; the file wins when present.
const DEFAULT_MODEL_RULES = [
  { match: ["minimax", "m3"], policy: "model.minimax-m3" },
  { match: ["deepseek"], policy: "model.deepseek" },
];

export function loadModelRules(packageRoot) {
  try {
    const raw = JSON.parse(
      readFileSync(join(packageRoot, "config", "models.json"), "utf8"),
    );
    if (Array.isArray(raw?.rules)) return raw.rules;
  } catch {
    // No/invalid config — fall back to built-in rules.
  }
  return DEFAULT_MODEL_RULES;
}

/** First rule whose every pattern token appears in "provider/id" wins. */
export function modelPolicyId(model, rules = DEFAULT_MODEL_RULES) {
  const provider = String(model?.provider ?? "").toLowerCase();
  const id = String(model?.id ?? model?.name ?? "").toLowerCase();
  const all = `${provider}/${id}`;
  for (const rule of rules ?? []) {
    const patterns = Array.isArray(rule?.match) ? rule.match : [];
    if (patterns.length > 0 && patterns.every((p) => all.includes(p))) {
      return rule.policy ?? null;
    }
  }
  return null;
}

export function chooseRigor(classification, requestedMode = "auto") {
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

export function chooseFlow(classification) {
  return FLOW_BY_TASK[classification.taskType] ?? null;
}

export function chooseProfile(classification, requestedProfile = "auto") {
  if (requestedProfile && requestedProfile !== "auto") return requestedProfile;
  return PROFILE_BY_TASK[classification.taskType] ?? "coding";
}

export function buildDecision({
  classification,
  mode,
  profile,
  model,
  modelRules = null,
}) {
  const rigor = chooseRigor(classification, mode);
  const selectedProfile = chooseProfile(classification, profile);
  const modelPolicy = modelPolicyId(
    model,
    modelRules ?? DEFAULT_MODEL_RULES,
  );

  return {
    taskType: classification.taskType,
    risk: classification.risk,
    confidence: classification.confidence,
    executionIntent: classification.executionIntent,
    domains: classification.domains,
    concerns: classification.concerns,
    rigor,
    flow: chooseFlow(classification),
    profile: selectedProfile,
    modelPolicy,
    reasons: classification.reasons,
  };
}
