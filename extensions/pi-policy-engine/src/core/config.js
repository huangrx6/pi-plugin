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

export function loadEffectiveConfig({
  packageRoot,
  cwd,
  runtimeOverrides = {},
}) {
  const defaults = safeJson(join(packageRoot, "config", "defaults.json"), {});
  const globalConfig = safeJson(
    join(homedir(), ".pi", "agent", "policy-engine.json"),
    {},
  );
  const projectLayers = projectConfigFiles(cwd).map((f) =>
    f.error ? {} : safeJson(f.path, {}),
  );
  return mergeConfig(
    defaults,
    globalConfig,
    ...projectLayers,
    runtimeOverrides,
  );
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
