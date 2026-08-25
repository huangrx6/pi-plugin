// Runtime state + classification/decision glue.
// Single instance per extension load; reset on session_start.

import { classifyTask } from "../../src/core/classifier.js";
import {
  loadEffectiveConfig,
  loadRoutingConfig,
} from "../../src/core/config.js";
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
