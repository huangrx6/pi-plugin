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
//
// v0.22: STRUCTURED matching (exact provider + exact-or-glob model). The
// previous substring rule array matched "minimax/m30" to the M3 policy and
// "notdeepseek/anything" to deepseek — verified. A trailing "*" in model
// is a prefix glob; everything else is exact (case-insensitive).
const DEFAULT_MODEL_RULES = [
  { provider: "minimax-cn", model: "MiniMax-M3", policy: "model.minimax-m3" },
  { provider: "deepseek", policy: "model.deepseek" },
];

export function loadModelRules(packageRoot) {
  try {
    const raw = JSON.parse(
      readFileSync(join(packageRoot, "config", "models.json"), "utf8"),
    );
    if (!Array.isArray(raw?.rules)) return DEFAULT_MODEL_RULES;
    // Reject legacy substring rules outright: they silently matched the
    // wrong models (m30→m3). Structured rules only.
    const structured = raw.rules.filter(
      (r) =>
        r &&
        (typeof r.provider === "string" || typeof r.model === "string") &&
        !Array.isArray(r.match),
    );
    return structured.length > 0 ? structured : DEFAULT_MODEL_RULES;
  } catch {
    // No/invalid config — fall back to built-in rules.
  }
  return DEFAULT_MODEL_RULES;
}

/**
 * v0.22 structured matching: provider must equal exactly (ci); model, when
 * declared, must equal exactly (ci) or prefix-match a trailing "*" glob.
 * A rule with neither field never matches. Legacy "match" substring arrays
 * are rejected at load (loadModelRules) — see models.json.
 */
export function modelPolicyId(model, rules = DEFAULT_MODEL_RULES) {
  const provider = String(model?.provider ?? "").toLowerCase();
  const id = String(model?.id ?? model?.name ?? "").toLowerCase();
  for (const rule of rules ?? []) {
    if (
      typeof rule?.provider === "string" &&
      rule.provider.toLowerCase() !== provider
    ) {
      continue;
    }
    if (typeof rule?.model === "string") {
      const want = rule.model.toLowerCase();
      const hit = want.endsWith("*")
        ? id.startsWith(want.slice(0, -1))
        : id === want;
      if (!hit) continue;
    }
    if (!rule.provider && !rule.model) continue; // empty rule never matches
    if (rule.policy) return rule.policy;
  }
  return null;
}

export function chooseRigor(classification, requestedMode = "auto") {
  // v0.22 P0: precedence is off > CURRENT-PROMPT explicit gate > pinned
  // runtime mode > risk routing. A stale /policy quick|standard must never
  // swallow a gate the user demands in the CURRENT prompt ("先给方案，确认
  // 后再执行" while runtime=standard used to route standard). The gate can
  // be lifted per-prompt too: "不用等我确认，直接执行" classifies null and
  // the pinned mode applies again. Only /policy off disables the engine
  // entirely and wins over everything.
  if (requestedMode === "off" || classification.taskType === "conversation")
    return "off";

  if (
    classification.approvalRequired === "explicit" &&
    classification.executionIntent !== "read-only"
  ) {
    return "strict";
  }

  if (
    ["quick", "standard", "strict"].includes(requestedMode) &&
    requestedMode !== "auto"
  ) {
    return requestedMode;
  }

  // Read-only intent never needs the strict approval cycle — downgrade to a
  // standard (or quick) read-only flow. "unclear" keeps full rigor: we can't
  // prove it won't mutate.
  if (classification.executionIntent === "read-only") {
    if (classification.coverage === "comprehensive") return "standard";
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
  const modelPolicy = modelPolicyId(model, modelRules ?? DEFAULT_MODEL_RULES);

  return {
    taskType: classification.taskType,
    coverage: classification.coverage ?? "focused",
    risk: classification.risk,
    confidence: classification.confidence,
    executionIntent: classification.executionIntent,
    executionTiming: classification.executionTiming,
    approvalRequired: classification.approvalRequired ?? null,
    domains: classification.domains,
    concerns: classification.concerns,
    rigor,
    flow: chooseFlow(classification),
    profile: selectedProfile,
    modelPolicy,
    reasons: classification.reasons,
  };
}
