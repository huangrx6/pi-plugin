import { validateShape, DOMAINS } from "./schema.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { globalConfigPath, defaultHistoryFilePath } from "./paths.js";

function safeJson(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Project config files from cwd upward to the enclosing git root (v0.20),
 * NEAREST LAST so it wins the merge — mirroring projectPolicyRoots. Before
 * this, .pi/policy-engine.json was read at cwd only while .pi/policies
 * walked up: starting pi in repo/backend/service silently ignored the
 * repo-root config. Returns [{ path, error }] where error is set when the
 * file exists but does not parse (surfaced via /policy validate; the
 * merge itself still ignores broken files).
 */
/**
 * The global config file, with a parse-error probe (v0.23 P2): project
 * layers already report broken JSON via projectConfigFiles/validate; the
 * GLOBAL layer was still silently swallowed by safeJson. Same treatment.
 */
export function globalConfigFile() {
  const path = globalConfigPath();
  if (!existsSync(path)) return null;
  let error = null;
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    error = e?.message ?? String(e);
  }
  return { path, error };
}

export function projectConfigFiles(cwd) {
  const out = [];
  let cur = resolve(String(cwd ?? "."));
  for (;;) {
    const file = join(cur, ".pi", "policy-engine.json");
    if (existsSync(file)) {
      let error = null;
      try {
        JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        error = e?.message ?? String(e);
      }
      out.push({ path: file, error });
    }
    if (existsSync(join(cur, ".git"))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out.reverse(); // nearest last = highest merge priority
}

// v0.21 P0 — config trust boundary (dual-trust model, clarified v0.22):
// a project's .pi/policy-engine.json is TRUSTED for routing/behavior
// customization (mode, policy selection, budgets — a repo may legitimately
// carry its own conventions, exactly like project instructions), and is
// NEVER trusted with host credentials, arbitrary network destinations, or
// arbitrary filesystem destinations. The second half is why
// semanticFallback (verified exfiltration path: project endpoint +
// apiKeyEnvVar → Bearer <secret> + full prompt) and historyFile (append
// JSONL to arbitrary user files) are global-only, whatever the project
// layer says.
const PRIVILEGED_KEYS = [
  "semanticFallback",
  "historyFile",
  "historyMaxEntries",
  "modelRules",
];

const SAFE_PROJECT_KEYS = [
  "mode",
  "profile",
  "showStatus",
  "maxDomains",
  "domainHints",
  "includePolicies",
  "excludePolicies",
  "projectPolicies",
  "projectPolicyMaxFiles",
  "projectPolicyMaxBytes",
  "policyMaxBytes",
];

/** Drop every privileged key from a project config layer. */
export function sanitizeProjectConfig(projectConfig) {
  if (!projectConfig || typeof projectConfig !== "object") return {};
  const out = {};
  for (const key of SAFE_PROJECT_KEYS) {
    if (key in projectConfig) out[key] = projectConfig[key];
  }
  return out;
}

/**
 * Privileged keys found in project config layers — surfaced by
 * /policy validate so users learn WHY their project config is ignored,
 * not just that it is.
 */
export function projectConfigViolations(cwd) {
  const out = [];
  for (const f of projectConfigFiles(cwd)) {
    if (f.error) continue;
    const raw = safeJson(f.path, {});
    if (!isPlainObject(raw)) continue;
    for (const key of PRIVILEGED_KEYS) {
      if (key in raw) out.push({ path: f.path, key });
    }
  }
  return out;
}

function isPlainObject(v) {
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (Array.isArray(value)) {
      // Array merge strategy: union by id (objects with `id`/`policy` field),
      // otherwise replace. This makes `includePolicies` / `excludePolicies`
      // declarative across config layers without dropping items from lower
      // priority sources.
      if (
        Array.isArray(existing) &&
        value.every((v) => isPlainObject(v) && typeof v.id === "string")
      ) {
        // Dedupe by id with later-override. Priority order in mergeConfig
        // means later configs override earlier ones (defaults < global <
        // project < runtime), so when two configs both declare an item with
        // the same id the later value wins but keeps the earlier position.
        const seen = new Map();
        for (const item of [...existing, ...value]) {
          if (seen.has(item.id)) {
            seen.set(item.id, { ...seen.get(item.id), ...item });
          } else {
            seen.set(item.id, item);
          }
        }
        out[key] = [...seen.values()];
      } else {
        out[key] = [...value];
      }
    } else if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function mergeConfig(...configs) {
  let out = {};
  for (const cfg of configs) {
    if (!isPlainObject(cfg)) continue;
    out = deepMerge(out, cfg);
  }
  return out;
}

const BUILTIN_PROFILES = [
  "auto",
  "coding",
  "debugging",
  "review",
  "research",
  "architecture",
  "documentation",
];
const BUILTIN_MODES = ["auto", "quick", "standard", "strict", "off"];

const num = (v, fallback) => {
  return Number.isInteger(v) && v > 0 && v <= 1048576 ? v : fallback;
};

/**
 * Runtime normalization (v0.21 P1). /policy validate diagnoses bad config,
 * but the runtime must not consume it: "maxDomains": "oops" made
 * Math.max(1, NaN) → NaN → the domain cap NEVER fired (four domains
 * loaded); "policyMaxBytes": "oops" failed the budget OPEN (everything
 * loaded); an unknown profile silently dropped all profile behaviors.
 * Invalid values fall back to defaults; valid values pass through.
 */
export function normalizeEffectiveConfig(cfg) {
  const out = structuredClone(cfg ?? {});
  if (!BUILTIN_MODES.includes(out.mode)) out.mode = "auto";
  if (!BUILTIN_PROFILES.includes(out.profile)) out.profile = "auto";
  out.maxDomains =
    Number.isInteger(out.maxDomains) &&
    out.maxDomains > 0 &&
    out.maxDomains <= 16
      ? out.maxDomains
      : 2;
  out.policyMaxBytes = num(out.policyMaxBytes, 24000);
  out.projectPolicyMaxFiles =
    Number.isInteger(out.projectPolicyMaxFiles) &&
    out.projectPolicyMaxFiles > 0 &&
    out.projectPolicyMaxFiles <= 1000
      ? out.projectPolicyMaxFiles
      : 12;
  out.projectPolicyMaxBytes = num(out.projectPolicyMaxBytes, 24000);
  out.historyMaxEntries =
    Number.isInteger(out.historyMaxEntries) &&
    out.historyMaxEntries > 0 &&
    out.historyMaxEntries <= 10000
      ? out.historyMaxEntries
      : 500;
  for (const key of [
    "domainHints",
    "includePolicies",
    "excludePolicies",
    "projectPolicies",
  ]) {
    if (
      out[key] !== undefined &&
      (!Array.isArray(out[key]) || out[key].some((v) => typeof v !== "string"))
    )
      out[key] = [];
  }
  if (out.domainHints)
    out.domainHints = out.domainHints
      .filter((v) => DOMAINS.includes(v))
      .slice(0, out.maxDomains);
  if (typeof out.showStatus !== "boolean") out.showStatus = true;
  if (out.historyFile !== null && typeof out.historyFile !== "string")
    out.historyFile = null;
  if (validateShape({ modelRules: out.modelRules }).length) out.modelRules = [];
  if (
    !out.semanticFallback ||
    typeof out.semanticFallback !== "object" ||
    Array.isArray(out.semanticFallback)
  )
    out.semanticFallback = { enabled: false };
  const fb = out.semanticFallback;
  if (fb.enabled !== true) fb.enabled = false;
  if (fb && typeof fb === "object") {
    const t = Number(fb.confidenceThreshold);
    if (!(t > 0 && t < 1)) fb.confidenceThreshold = 0.7;
    const ms = Number(fb.timeoutMs);
    if (!(ms > 0 && ms <= 60000)) fb.timeoutMs = 4000;
    if (validateShape({ semanticFallback: fb }).length) fb.enabled = false;
  }
  return out;
}

export function loadEffectiveConfig({
  packageRoot,
  cwd,
  runtimeOverrides = {},
  raw = false,
}) {
  const defaults = safeJson(join(packageRoot, "config", "defaults.json"), {});
  defaults.historyFile = defaultHistoryFilePath();
  const globalConfig = safeJson(globalConfigPath(), {});
  // Preserve the meaning of existing endpoint configurations on upgrade.
  if (
    isPlainObject(globalConfig?.semanticFallback) &&
    globalConfig.semanticFallback.source === undefined
  ) {
    globalConfig.semanticFallback.source = "endpoint";
    globalConfig.semanticFallback.strategy ??= "fallback";
    globalConfig.semanticFallback.timeoutMs ??= 4000;
  }
  // Project layers are sanitized BEFORE merging — the trust boundary is
  // structural, not advisory (see PRIVILEGED_KEYS).
  const projectLayers = projectConfigFiles(cwd).map((f) =>
    f.error ? {} : sanitizeProjectConfig(safeJson(f.path, {})),
  );
  const merged = mergeConfig(
    defaults,
    globalConfig,
    ...projectLayers,
    runtimeOverrides,
  );
  // raw = skip normalization (used by /policy validate so it can report
  // the invalid values instead of the silently-fixed ones).
  const diagnostics = validateShape(merged);
  for (const f of [globalConfigFile(), ...projectConfigFiles(cwd)].filter(
    Boolean,
  )) {
    if (!f.error)
      for (const issue of validateShape(safeJson(f.path, {})))
        diagnostics.push({ ...issue, message: `${f.path}: ${issue.message}` });
  }
  const sources = {};
  const layers = [
    { path: join(packageRoot, "config", "defaults.json"), data: defaults },
    { path: globalConfigPath(), data: globalConfig },
    ...projectConfigFiles(cwd)
      .filter((f) => !f.error)
      .map((f) => ({
        path: f.path,
        data: sanitizeProjectConfig(safeJson(f.path, {})),
      })),
    { path: "runtime", data: runtimeOverrides },
  ];
  const visit = (obj, prefix, source) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v)) visit(v, key, source);
      else sources[key] = source;
    }
  };
  for (const layer of layers) visit(layer.data, "", layer.path);
  for (const f of [globalConfigFile(), ...projectConfigFiles(cwd)].filter(
    Boolean,
  ))
    if (f.error)
      diagnostics.push({
        severity: "error",
        message: `${f.path}: invalid JSON (${f.error})`,
      });
  const out = raw ? merged : normalizeEffectiveConfig(merged);
  out._diagnostics = diagnostics;
  out._sources = sources;
  return out;
}

export function loadRoutingConfig(packageRoot) {
  return safeJson(join(packageRoot, "config", "routing.json"), {
    taskRules: {},
    domainRules: {},
    highRisk: [],
    mediumRisk: [],
    simpleHints: [],
  });
}
