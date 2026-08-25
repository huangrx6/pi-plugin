// Runtime state + classification/decision glue.
// Single instance per extension load; reset on session_start.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { classifyTask } from "../../src/core/classifier.js";
import { classifyFollowUp } from "../../src/core/intent.js";
import {
  loadEffectiveConfig,
  loadRoutingConfig,
  projectConfigFiles,
  projectConfigViolations,
} from "../../src/core/config.js";
import {
  composeAllPolicies,
  loadManifest,
  loadProfile,
} from "../../src/core/loader.js";
import { buildDecision, loadModelRules } from "../../src/core/router.js";
import { maybeSemanticClassify } from "../../src/core/semantic.js";

export function createState() {
  return {
    runtimeMode: null,
    runtimeProfile: null,
    onceMode: null,
    lastDecision: null,
    lastPrompt: null,
    // Single source of truth for the strict-workflow state machine:
    // idle / planning / awaiting_approval / executing.
    phase: "idle",
    currentModel: null,
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
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
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
    workflow: decision.rigor ?? decision.workflow,
    profile: decision.profile,
    confidence: decision.confidence,
  });
  while (state.history.length > HISTORY_CAP) state.history.shift();
}

function stateRuntimeOverrides(state) {
  const out = {};
  if (state.runtimeMode) out.mode = state.runtimeMode;
  if (state.runtimeProfile) out.profile = state.runtimeProfile;
  return out;
}

export function buildEffectiveConfig({ packageRoot, cwd, state, raw = false }) {
  // raw = skip runtime normalization: /policy validate must see the actual
  // (possibly invalid) values to report them; every runtime consumer gets
  // the normalized form.
  return loadEffectiveConfig({
    packageRoot,
    cwd,
    runtimeOverrides: stateRuntimeOverrides(state),
    raw,
  });
}

function resolvePreviewPhase(decision) {
  if (decision.rigor === "off") return "idle";
  if (decision.rigor === "strict" && decision.executionIntent !== "read-only") {
    return "planning";
  }
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
  let classification = classifyTask(prompt, routing, config.domainHints ?? [], {
    maxDomains: config.maxDomains,
  });

  // v0.18 Task Continuity: a bare follow-up ("继续" / "还是不对") carries
  // no instructions of its own — it points at the PREVIOUS task. Inherit
  // task + domains from the last decision, recompute intent from the
  // follow-up text (fresh intent wins; unclear falls back to inherited),
  // and never let risk DROP across turns (escalation only). Without this,
  // a bare follow-up after a debugging/database task re-classified as
  // coding/none and drifted the model off its constraints.
  const last = state.lastDecision;
  const followUp = classifyFollowUp(prompt);
  if (last && last.rigor !== "off" && followUp.type !== "none") {
    const fresh = classification;
    const RANK = { low: 0, medium: 1, high: 2 };
    // A bare follow-up carries no risk signal of its own — the fresh
    // classification's "medium" is the no-evidence DEFAULT, not a finding.
    // Escalate only when the fresh pass found an actual risk reason;
    // otherwise "继续" after a quick task would silently become standard.
    const freshHasRiskSignal = (fresh.reasons ?? []).some((r) =>
      r.startsWith("risk:"),
    );
    const risk =
      freshHasRiskSignal && RANK[fresh.risk] > RANK[last.risk]
        ? fresh.risk
        : last.risk;
    // Follow-up typing drives intent (v0.20):
    //   execute ("按这个做" after a read-only analysis) → mutate
    //   inspect / neutral → fresh intent, falling back to the inherited one
    const executionIntent =
      followUp.type === "execute"
        ? "mutate"
        : fresh.executionIntent === "unclear"
          ? (last.executionIntent ?? "unclear")
          : fresh.executionIntent;
    // Cross-cutting constraints survive continuity (v0.20): a "继续" after
    // a security-relevant task must not drop the security concern.
    const concerns = [
      ...new Set([...(last.concerns ?? []), ...(fresh.concerns ?? [])]),
    ];
    classification = {
      ...fresh,
      taskType: last.taskType,
      runnerUpTask: fresh.taskType,
      domains: last.domains ?? [],
      concerns,
      risk,
      executionIntent,
      reasons: [
        `task-continuity: ${followUp.type} follow-up inherits task=${last.taskType} domains=[${(last.domains ?? []).join(",")}] concerns=[${concerns.join(",") || "none"}] from the previous turn; intent/risk recomputed (risk never drops)`,
        ...fresh.reasons,
      ],
    };
  }
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
    modelRules: loadModelRules(packageRoot),
  });
  return { decision, config, classification };
}

/**
 * Validate the resolved config against the package manifest and project
 * files. Pure read — no state mutation. Used by `/policy validate`.
 *
 * Checks:
 *  - includePolicies / excludePolicies reference manifest ids OR the
 *    built-in core.* / model.* namespaces (warnings otherwise).
 *  - profile.<name>.json entries reference valid ids (errors).
 *  - manifest paths exist on disk (errors).
 *
 * Returns { ok, issues: [{ severity: 'error' | 'warning', message }] }.
 */
/**
 * Merge a plan REVISION into the pending decision (v0.22).
 *
 * Two kinds of revision:
 *  - CONSTRAINT ("批准，但是不要改 schema"): task/flow/intent untouched;
 *    risk only up; domains/concerns merged conservatively — now honoring
 *    the effective config (maxDomains, domainHints), which the previous
 *    inline lifecycle copy ignored (cap was hardcoded ≥2, no hints).
 *  - REPLACEMENT ("不实施了，改成只更新 README" / "不要执行了，改成只分析
 *    风险"): a correction/replacement frame redirects the work — full
 *    reroute on the fresh classification, previous risk kept as a floor,
 *    still strict + planning (the new plan needs approval again).
 */
export function mergeRevisionDecision({
  previous,
  prompt,
  config,
  packageRoot,
}) {
  const routing = loadRoutingConfig(packageRoot);
  const delta = classifyTask(prompt, routing, config.domainHints ?? [], {
    maxDomains: config.maxDomains,
  });
  const RANK = { low: 0, medium: 1, high: 2 };

  const REPLACEMENT_RE =
    /(不实施了?|别实施了?|不要实施|先不实施|不要执行了?|先不做了?|改成只|换成只|改为只|不干了，?改|don'?t implement|don'?t execute)/;
  if (REPLACEMENT_RE.test(prompt)) {
    const decision = buildDecision({
      classification: delta,
      mode: "strict",
      profile: config.profile ?? "auto",
      model: null,
    });
    decision.risk =
      RANK[delta.risk] > RANK[previous.risk] ? delta.risk : previous.risk;
    decision.reasons = [
      ...(previous.reasons ?? []),
      `plan-revision: task replaced (${previous.taskType}/${previous.executionIntent} → ${decision.taskType}/${decision.executionIntent}); re-routed fresh, approval still required`,
      ...(delta.reasons ?? []),
    ];
    return decision;
  }

  const risk =
    RANK[delta.risk] > RANK[previous.risk] ? delta.risk : previous.risk;
  // v0.22: the domain cap honors the CURRENT config — a maxDomains:1
  // session no longer lets a revision grow to 2 (verified bug).
  const cap = Math.max(1, Number(config.maxDomains ?? 2));
  const domains = [
    ...new Set([...(previous.domains ?? []), ...(delta.domains ?? [])]),
  ].slice(0, cap);
  const concerns = [
    ...new Set([...(previous.concerns ?? []), ...(delta.concerns ?? [])]),
  ];
  const notes = [];
  if (risk !== previous.risk) notes.push(`risk ${previous.risk}→${risk}`);
  const addedDomains = domains.filter(
    (d) => !(previous.domains ?? []).includes(d),
  );
  if (addedDomains.length > 0) notes.push(`+domains ${addedDomains}`);
  const addedConcerns = concerns.filter(
    (c) => !(previous.concerns ?? []).includes(c),
  );
  if (addedConcerns.length > 0) notes.push(`+concerns ${addedConcerns}`);
  return {
    ...previous,
    risk,
    domains,
    concerns,
    reasons: [
      ...(previous.reasons ?? []),
      `plan-revision: ${notes.length > 0 ? notes.join("; ") : "no routing change"}`,
      ...delta.reasons.filter(
        (r) =>
          r.startsWith("risk:") ||
          r.startsWith("domain:") ||
          r.startsWith("concern:"),
      ),
    ],
  };
}

export function validateConfig({ config, packageRoot, cwd = null }) {
  const issues = [];
  const push = (severity, message) => issues.push({ severity, message });

  // ---- v0.20: schema freeze actually validated ----------------------------
  // A frozen schema deserves real checks, not just id-reference lookups.
  const MODES = ["auto", "quick", "standard", "strict", "off"];
  if (config.mode !== undefined && !MODES.includes(config.mode)) {
    push("error", `mode: '${config.mode}' is not one of ${MODES.join(" | ")}`);
  }
  const PROFILES = [
    "auto",
    "coding",
    "debugging",
    "review",
    "research",
    "architecture",
    "documentation",
  ];
  if (config.profile !== undefined && !PROFILES.includes(config.profile)) {
    push(
      "warning",
      `profile: '${config.profile}' is not a built-in profile (${PROFILES.join(", ")}) — loading falls back to defaults`,
    );
  }
  if (config.maxDomains !== undefined && !(Number(config.maxDomains) > 0)) {
    push("error", `maxDomains: must be > 0 (got ${config.maxDomains})`);
  }
  if (
    config.policyMaxBytes !== undefined &&
    !(Number(config.policyMaxBytes) > 0)
  ) {
    push("error", `policyMaxBytes: must be > 0 (got ${config.policyMaxBytes})`);
  }
  if (
    config.projectPolicyMaxFiles !== undefined &&
    !(Number(config.projectPolicyMaxFiles) > 0)
  ) {
    push(
      "error",
      `projectPolicyMaxFiles: must be > 0 (got ${config.projectPolicyMaxFiles})`,
    );
  }
  const fb = config.semanticFallback;
  if (fb && fb.enabled === true) {
    if (typeof fb.endpoint !== "string" || !/^https?:\/\//.test(fb.endpoint)) {
      push(
        "error",
        "semanticFallback.endpoint: must be an http(s) URL when enabled",
      );
    }
    if (typeof fb.model !== "string" || !fb.model) {
      push(
        "error",
        "semanticFallback.model: must be a non-empty string when enabled",
      );
    }
    if (typeof fb.apiKeyEnvVar !== "string" || !fb.apiKeyEnvVar) {
      push("error", "semanticFallback.apiKeyEnvVar: must be set when enabled");
    }
    if (
      fb.confidenceThreshold !== undefined &&
      !(fb.confidenceThreshold > 0 && fb.confidenceThreshold < 1)
    ) {
      push(
        "error",
        `semanticFallback.confidenceThreshold: must be in (0, 1) (got ${fb.confidenceThreshold})`,
      );
    }
    if (fb.timeoutMs !== undefined && !(Number(fb.timeoutMs) > 0)) {
      push(
        "error",
        `semanticFallback.timeoutMs: must be > 0 (got ${fb.timeoutMs})`,
      );
    }
  }

  // Broken config JSON must not be silent (v0.20): safeJson swallows parse
  // errors during merging, so surface them here.
  if (cwd) {
    for (const f of projectConfigFiles(cwd)) {
      if (f.error) {
        push("error", `project config ${f.path}: invalid JSON (${f.error})`);
      }
    }
    // v0.21 trust boundary: privileged keys in project config are dropped
    // at load time — say so, or users debug config that never applies.
    for (const v of projectConfigViolations(cwd)) {
      push(
        "error",
        `project config ${v.path}: key '${v.key}' is global-only (network/credential/filesystem settings cannot come from a project layer; ignored)`,
      );
    }
  }

  // Reference checks against manifest + core.* + model.*
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
    ["rigor", left?.decision?.rigor, right?.decision?.rigor],
    [
      "flow",
      left?.decision?.flow ?? "default",
      right?.decision?.flow ?? "default",
    ],
    ["task", left?.decision?.taskType, right?.decision?.taskType],
    ["risk", left?.decision?.risk, right?.decision?.risk],
    ["confidence", left?.decision?.confidence, right?.decision?.confidence],
    [
      "domains",
      (left?.decision?.domains ?? []).join(","),
      (right?.decision?.domains ?? []).join(","),
    ],
    [
      "concerns",
      (left?.decision?.concerns ?? []).join(","),
      (right?.decision?.concerns ?? []).join(","),
    ],
    ["profile", left?.decision?.profile, right?.decision?.profile],
    [
      "model policy",
      left?.decision?.modelPolicy ?? "default",
      right?.decision?.modelPolicy ?? "default",
    ],
    [
      "execution intent",
      left?.decision?.executionIntent,
      right?.decision?.executionIntent,
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
  // v0.17: ONE total budget — built-ins + project combined under
  // policyMaxBytes (previously each list was capped independently and the
  // preview only reported the built-in share, hiding up to 2× overflow).
  const { policies, projectPolicies, truncated, builtInBytes, projectBytes } =
    composeAllPolicies({ packageRoot, cwd, decision, config, phase });
  const budget = Number(config.policyMaxBytes ?? 24000);
  const totalBytes = builtInBytes + projectBytes;
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
      decision.rigor === "strict" && decision.executionIntent !== "read-only",
    stats: {
      builtInCount: policies.length,
      builtInBytes,
      projectCount: projectPolicies.length,
      projectBytes,
      budget,
      budgetUsedPct: Math.min(
        100,
        Math.round((totalBytes / Math.max(1, budget)) * 100),
      ),
    },
  };
}
