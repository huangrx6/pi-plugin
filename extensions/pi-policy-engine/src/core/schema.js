// Shared configuration shape checks. No host or filesystem dependencies.
export const MODES = ["auto", "quick", "standard", "strict", "off"];
export const PROFILES = [
  "auto",
  "coding",
  "debugging",
  "review",
  "research",
  "architecture",
  "documentation",
];
export const DOMAINS = [
  "database",
  "kubernetes",
  "backend",
  "frontend",
  "documentation",
];
const caps = {
  maxDomains: 16,
  policyMaxBytes: 1048576,
  projectPolicyMaxFiles: 1000,
  projectPolicyMaxBytes: 1048576,
  historyMaxEntries: 10000,
};
export function validateShape(config) {
  const issues = [];
  const error = (key, message) =>
    issues.push({ severity: "error", message: `${key}: ${message}` });
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    error("config", "must be an object");
    return issues;
  }
  for (const [key, values] of Object.entries({
    mode: MODES,
    profile: PROFILES,
  })) {
    if (config[key] !== undefined && !values.includes(config[key]))
      error(key, `must be one of ${values.join(", ")}`);
  }
  for (const [key, max] of Object.entries(caps)) {
    const v = config[key];
    if (v !== undefined && !(Number.isInteger(v) && v > 0 && v <= max))
      error(key, `must be an integer in [1, ${max}]`);
  }
  if (config.showStatus !== undefined && typeof config.showStatus !== "boolean")
    error("showStatus", "must be boolean");
  for (const key of [
    "domainHints",
    "includePolicies",
    "excludePolicies",
    "projectPolicies",
  ]) {
    const v = config[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x))
      error(key, "must be an array of nonempty strings");
    else if (key === "domainHints" && v.some((x) => !DOMAINS.includes(x)))
      error(key, "contains an unknown domain");
  }
  if (
    config.historyFile !== undefined &&
    config.historyFile !== null &&
    typeof config.historyFile !== "string"
  )
    error("historyFile", "must be a path string or null");
  if (config.modelRules !== undefined) {
    if (!Array.isArray(config.modelRules))
      error("modelRules", "must be an array");
    else
      for (const [i, r] of config.modelRules.entries()) {
        if (
          !r ||
          typeof r !== "object" ||
          (!r.provider && !r.model) ||
          typeof r.policy !== "string" ||
          !r.policy ||
          ["provider", "model"].some(
            (k) => r[k] !== undefined && (typeof r[k] !== "string" || !r[k]),
          ) ||
          Object.keys(r).some(
            (k) => !["provider", "model", "policy"].includes(k),
          )
        )
          error(`modelRules[${i}]`, "requires provider/model and a policy id");
      }
  }
  const fb = config.recognition;
  if (fb !== undefined) {
    if (!fb || typeof fb !== "object" || Array.isArray(fb))
      error("recognition", "must be an object");
    else {
      if (fb.source !== undefined && !["agent", "endpoint"].includes(fb.source))
        error("recognition.source", "must be agent or endpoint");
      if (
        fb.protocol !== undefined &&
        !["openai", "anthropic"].includes(fb.protocol)
      )
        error("recognition.protocol", "must be openai or anthropic");
      if (
        fb.maxContextChars !== undefined &&
        !(
          Number.isInteger(fb.maxContextChars) &&
          fb.maxContextChars >= 1000 &&
          fb.maxContextChars <= 200000
        )
      )
        error(
          "recognition.maxContextChars",
          "must be an integer in [1000, 200000]",
        );
      for (const k of ["enabled", "jsonResponse"])
        if (fb[k] !== undefined && typeof fb[k] !== "boolean")
          error(`recognition.${k}`, "must be boolean");
      for (const k of ["endpoint", "model", "apiKeyEnvVar"])
        if (
          fb[k] !== undefined &&
          !(k === "apiKeyEnvVar" && fb[k] === null) &&
          (typeof fb[k] !== "string" || !fb[k])
        )
          error(`recognition.${k}`, "must be a nonempty string");
      if (
        fb.endpoint !== undefined &&
        (typeof fb.endpoint !== "string" || !/^https?:\/\//.test(fb.endpoint))
      )
        error("recognition.endpoint", "must be an http(s) URL");
      if (
        fb.timeoutMs !== undefined &&
        !(
          Number.isInteger(fb.timeoutMs) &&
          fb.timeoutMs > 0 &&
          fb.timeoutMs <= 60000
        )
      )
        error("recognition.timeoutMs", "must be an integer in [1, 60000]");
      if (
        fb.temperature !== undefined &&
        fb.temperature !== null &&
        !(
          typeof fb.temperature === "number" &&
          fb.temperature >= 0 &&
          fb.temperature <= 2
        )
      )
        error(
          "recognition.temperature",
          "must be null or a number in [0, 2]",
        );
      for (const k of Object.keys(fb))
        if (
          ![
            "enabled",
            "endpoint",
            "model",
            "apiKeyEnvVar",
            "timeoutMs",
            "jsonResponse",
            "temperature",
            "source",
            "protocol",
            "maxContextChars",
          ].includes(k)
        )
          error(`recognition.${k}`, "unknown setting");
    }
  }
  const known = new Set([
    "mode",
    "profile",
    "showStatus",
    ...Object.keys(caps),
    "domainHints",
    "includePolicies",
    "excludePolicies",
    "projectPolicies",
    "historyFile",
    "modelRules",
    "recognition",
  ]);
  for (const key of Object.keys(config))
    if (!known.has(key) && !key.startsWith("_")) error(key, "unknown setting");
  return issues;
}
