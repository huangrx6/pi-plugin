// Runtime state + classification/decision glue.
// Single instance per extension load; reset on session_start.

import { classifyTask } from "../../src/core/classifier.js";
import {
  loadEffectiveConfig,
  loadRoutingConfig,
} from "../../src/core/config.js";
import {
  composePolicies,
  loadProjectPolicies,
} from "../../src/core/loader.js";
import { buildDecision } from "../../src/core/router.js";
import { maybeSemanticClassify } from "../../src/core/semantic.js";

export function createState() {
  return {
    runtimeMode: null,
    runtimeGate: null,
    runtimeProfile: null,
    onceMode: null,
    lastDecision: null,
    lastPrompt: null,
    pendingApproval: false,
    phase: "idle",
    currentModel: null,
    // Compiled custom mutating shell patterns (from guard.customPatterns).
    // Refreshed on session_start; invalid patterns are surfaced to the user
    // exactly once per session via state.customPatternWarningsEmitted.
    customPatterns: [],
    customPatternWarningsEmitted: false,
  };
}

export function stateRuntimeOverrides(state) {
  const out = {};
  if (state.runtimeMode) out.mode = state.runtimeMode;
  if (state.runtimeGate) out.gate = state.runtimeGate;
  if (state.runtimeProfile) out.profile = state.runtimeProfile;
  return out;
}

export function buildEffectiveConfig({ packageRoot, cwd, state }) {
  return loadEffectiveConfig({
    packageRoot,
    cwd,
    runtimeOverrides: stateRuntimeOverrides(state),
  });
}

function resolvePreviewPhase(decision) {
  if (decision.workflow === "off") return "idle";
  if (decision.workflow === "strict" && !decision.analysisOnly)
    return "planning";
  return "executing";
}

/**
 * Pure classifier -> router glue. Loads the package routing config, calls
 * `classifyTask`, then `buildDecision` with the resolved mode + profile.
 *
 * Async because the optional `semanticFallback` may issue a one-shot HTTP
 * call to a small LLM when the deterministic confidence is low (DESIGN §4).
 * Any fallback failure is swallowed and the deterministic decision stands.
 */
export async function decide({
  packageRoot,
  cwd,
  prompt,
  state,
  model,
  explicitMode = null,
  fetcher,
}) {
  const config = buildEffectiveConfig({ packageRoot, cwd, state });
  const routing = loadRoutingConfig(packageRoot);
  let classification = classifyTask(
    prompt,
    routing,
    config.domainHints ?? [],
  );
  const mode = explicitMode ?? state.onceMode ?? config.mode ?? "auto";

  // Optional semantic fallback (DESIGN §4). Disabled by default. Any
  // failure (network / timeout / schema) returns null and we keep the
  // deterministic result.
  const merged = await maybeSemanticClassify(prompt, classification, config, {
    fetcher,
  });
  if (merged) classification = merged;

  const decision = buildDecision({
    classification,
    mode,
    profile: config.profile ?? "auto",
    model,
    gate: config.gate ?? "soft",
  });
  return { decision, config, classification };
}

/**
 * Dry-run classification + policy composition for a given prompt. Used by
 * `/policy preview <prompt>`. Does NOT mutate state, does NOT block, does
 * NOT touch any runtime override — it's a pure read.
 *
 * Returns a structured object suitable for `formatPreview` to render.
 */
export async function preview({ packageRoot, cwd, prompt, model, fetcher }) {
  // Build a fake state with no overrides so preview always reflects the
  // resolved config + the prompt, regardless of any in-session overrides.
  const previewState = createState();
  const { decision, config, classification } = await decide({
    packageRoot,
    cwd,
    prompt,
    state: previewState,
    model,
    fetcher,
  });
  const phase = resolvePreviewPhase(decision);
  const { policies, truncated } = composePolicies({
    packageRoot,
    decision,
    config,
    phase,
  });
  const projectPolicies = loadProjectPolicies(cwd, config);
  // Approximate the byte usage of what would actually be injected.
  const builtInBytes = policies.reduce(
    (n, p) => n + Buffer.byteLength(p.content, "utf8"),
    0,
  );
  const projectBytes = projectPolicies.reduce(
    (n, p) => n + Buffer.byteLength(p.content, "utf8"),
    0,
  );
  const budget = Number(config.policyMaxBytes ?? 24000);
  return {
    decision,
    classification,
    policies,
    projectPolicies,
    truncated,
    wouldRequireApproval:
      decision.workflow === "strict" && !decision.analysisOnly,
    stats: {
      builtInCount: policies.length,
      builtInBytes,
      projectCount: projectPolicies.length,
      projectBytes,
      budget,
      budgetUsedPct: Math.min(
        100,
        Math.round((builtInBytes / Math.max(1, budget)) * 100),
      ),
    },
  };
}
