// Runtime state + classification/decision glue.
// Single instance per extension load; reset on session_start.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compileCustomPatterns } from "../../src/core/guard.js";
import { classifyTask } from "../../src/core/classifier.js";
import {
  loadEffectiveConfig,
  loadRoutingConfig,
} from "../../src/core/config.js";
import {
  composePolicies,
  loadManifest,
  loadProfile,
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
    // In-session routing history. Capped (oldest dropped first) so a long
    // session doesn't grow unbounded. Cleared on session_start.
    history: [],
  };
}

export const HISTORY_CAP = 50;

function summarizePrompt(prompt) {
  const oneLine = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "..." : oneLine;
}

/**
 * Append a routing decision entry to the in-session history. Caps at
 * HISTORY_CAP entries (oldest dropped first).
 */
export function recordHistory(state, { source, prompt, decision }) {
  if (!decision) return;
  state.history.push({
    ts: Date.now(),
    source,
    prompt: summarizePrompt(prompt),
    task: decision.taskType,
    risk: decision.risk,
    workflow: decision.workflow,
    profile: decision.profile,
    gate: decision.gate,
    confidence: decision.confidence,
  });
  while (state.history.length > HISTORY_CAP) state.history.shift();
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
  let classification = classifyTask(prompt, routing, config.domainHints ?? []);
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
 * Validate the resolved config against the package manifest and project
 * files. Pure read — no state mutation. Used by `/policy validate`.
 *
 * Checks:
 *  - guard.customPatterns compile + have valid categories (errors).
 *  - includePolicies / excludePolicies reference manifest ids OR the
 *    built-in core.* / model.* namespaces (warnings otherwise).
 *  - profile.<name>.json entries reference valid ids (errors).
 *  - manifest paths exist on disk (errors).
 *
 * Returns { ok, issues: [{ severity: 'error' | 'warning', message }] }.
 */
export function validateConfig({ config, packageRoot }) {
  const issues = [];
  const push = (severity, message) => issues.push({ severity, message });

  // 1. customPatterns
  const { warnings } = compileCustomPatterns(config.guard);
  for (const w of warnings) push("error", `guard: ${w}`);

  // 2. Reference checks against manifest + core.* + model.*
  const manifest = loadManifest(packageRoot);
  const manifestIds = new Set(Object.keys(manifest?.policies ?? {}));
  const builtInPrefixes = ["core.", "model."];
  const isKnownId = (id) =>
    manifestIds.has(id) || builtInPrefixes.some((p) => id.startsWith(p));
  for (const id of config.includePolicies ?? []) {
    if (!isKnownId(id)) {
      push(
        "warning",
        `includePolicies: '${id}' is not in the package manifest and does not start with 'core.' or 'model.'. It will be silently ignored.`,
      );
    }
  }
  for (const id of config.excludePolicies ?? []) {
    if (!isKnownId(id)) {
      push(
        "warning",
        `excludePolicies: '${id}' is not in the package manifest and does not start with 'core.' or 'model.'. It will be silently ignored.`,
      );
    }
  }

  // 3. Manifest paths exist
  for (const [id, relPath] of Object.entries(manifest?.policies ?? {})) {
    const full = join(packageRoot, relPath);
    if (!existsSync(full)) {
      push(
        "error",
        `manifest: policy '${id}' -> '${relPath}' does not exist at ${full}`,
      );
    }
  }

  // 4. Profile policies
  const profileDir = join(packageRoot, "profiles");
  if (existsSync(profileDir)) {
    for (const file of readdirSync(profileDir)) {
      if (!file.endsWith(".json")) continue;
      const profileId = file.replace(/\.json$/, "");
      const profile = loadProfile(packageRoot, profileId);
      for (const id of profile?.policies ?? []) {
        if (!isKnownId(id)) {
          push(
            "error",
            `profile '${profileId}.json': policy '${id}' is not in the manifest and is not a core.*/model.* id`,
          );
        }
      }
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
  };
}

/**
 * Compare two decisions and return the list of fields that differ. Used by
 * `/policy diff`. Returns an array of `{ field, left, right }` objects
 * (only for fields where left !== right). Compares on the classification /
 * decision shape so it works with either preview or decide output.
 */
export function compareDecisions(left, right) {
  if (!left || !right) return [];
  const fields = [
    ["workflow", left?.decision?.workflow, right?.decision?.workflow],
    ["task", left?.decision?.taskType, right?.decision?.taskType],
    ["risk", left?.decision?.risk, right?.decision?.risk],
    ["confidence", left?.decision?.confidence, right?.decision?.confidence],
    [
      "domains",
      (left?.decision?.domains ?? []).join(","),
      (right?.decision?.domains ?? []).join(","),
    ],
    ["profile", left?.decision?.profile, right?.decision?.profile],
    ["gate", left?.decision?.gate, right?.decision?.gate],
    [
      "model policy",
      left?.decision?.modelPolicy ?? "default",
      right?.decision?.modelPolicy ?? "default",
    ],
    [
      "analysis only",
      left?.decision?.analysisOnly,
      right?.decision?.analysisOnly,
    ],
    [
      "would require approval",
      left?.wouldRequireApproval,
      right?.wouldRequireApproval,
    ],
  ];
  const out = [];
  for (const [field, l, r] of fields) {
    if (l !== r) out.push({ field, left: l, right: r });
  }
  return out;
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
    // Config is returned so callers (e.g. the /policy preview handler's
    // disk-history append) can read historyFile without a second
    // buildEffectiveConfig round-trip. v0.9 shipped the caller reading
    // `result.config?.historyFile` but this field was missing — the preview
    // path never persisted history. Restored here.
    config,
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
