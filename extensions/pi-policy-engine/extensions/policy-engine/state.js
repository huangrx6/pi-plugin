// Runtime state + classification/decision glue.
// Single instance per extension load; reset on session_start.

import { classifyTask } from "../../src/core/classifier.js";
import { loadEffectiveConfig, loadRoutingConfig } from "../../src/core/config.js";
import { buildDecision } from "../../src/core/router.js";

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

/**
 * Pure classifier -> router glue. Loads the package routing config, calls
 * `classifyTask`, then `buildDecision` with the resolved mode + profile.
 */
export function decide({ packageRoot, cwd, prompt, state, model, explicitMode = null }) {
  const config = buildEffectiveConfig({ packageRoot, cwd, state });
  const routing = loadRoutingConfig(packageRoot);
  const classification = classifyTask(prompt, routing, config.domainHints ?? []);
  const mode = explicitMode ?? state.onceMode ?? config.mode ?? "auto";
  const decision = buildDecision({
    classification,
    mode,
    profile: config.profile ?? "auto",
    model,
    gate: config.gate ?? "soft",
  });
  return { decision, config };
}
