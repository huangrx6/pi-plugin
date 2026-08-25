import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  const path = join(homedir(), ".pi", "agent", "policy-engine.json");
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
    if (!cfg || typeof cfg !== "object") continue;
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
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  const out = { ...cfg };
  if (!BUILTIN_MODES.includes(out.mode)) out.mode = "auto";
  if (!BUILTIN_PROFILES.includes(out.profile)) out.profile = "auto";
  out.maxDomains = num(out.maxDomains, 2);
  out.policyMaxBytes = num(out.policyMaxBytes, 24000);
  out.projectPolicyMaxFiles = num(out.projectPolicyMaxFiles, 12);
  out.projectPolicyMaxBytes = num(out.projectPolicyMaxBytes, 24000);
  out.historyMaxEntries = num(out.historyMaxEntries, 500);
  const fb = out.semanticFallback;
  if (fb && typeof fb === "object") {
    const t = Number(fb.confidenceThreshold);
    if (!(t > 0 && t < 1)) fb.confidenceThreshold = 0.7;
    const ms = Number(fb.timeoutMs);
    if (!(ms > 0)) fb.timeoutMs = 4000;
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
  const globalConfig = safeJson(
    join(homedir(), ".pi", "agent", "policy-engine.json"),
    {},
  );
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
  return raw ? merged : normalizeEffectiveConfig(merged);
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
