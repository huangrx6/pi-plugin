// Shared configuration shape checks. No host or filesystem dependencies.

// An allowlisted key that the current README documents but this runtime
// rejects is almost always version skew: the configuration was written
// against a newer pi-plugin than the installed clone. Say so at the
// report site instead of leaving a bare "unknown setting".
const UNKNOWN_HINT =
  "unknown setting (typo, or this configuration is newer than the installed pi-plugin — update the installed clone and reload)";

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
    if (Array.isArray(config.modelRules))
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
    else error("modelRules", "must be an array");
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
        error("recognition.temperature", "must be null or a number in [0, 2]");
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
            "onFailure",
            "requestBody",
            "autoTuning",
            "context",
          ].includes(k)
        )
          error(`recognition.${k}`, UNKNOWN_HINT);
      if (
        fb.onFailure !== undefined &&
        !["block", "rules"].includes(fb.onFailure)
      )
        error("recognition.onFailure", "must be block or rules");
      if (
        fb.requestBody !== undefined &&
        !(
          typeof fb.requestBody === "object" &&
          fb.requestBody !== null &&
          !Array.isArray(fb.requestBody)
        )
      )
        error("recognition.requestBody", "must be an object");
      if (fb.autoTuning !== undefined && typeof fb.autoTuning !== "boolean")
        error("recognition.autoTuning", "must be boolean");
      if (fb.context !== undefined) {
        const ctx = fb.context;
        if (!ctx || typeof ctx !== "object" || Array.isArray(ctx))
          error("recognition.context", "must be an object");
        else {
          if (
            ctx.profile !== undefined &&
            !["minimal", "standard", "rich"].includes(ctx.profile)
          )
            error(
              "recognition.context.profile",
              "must be minimal, standard or rich",
            );
          for (const [key, max] of [
            ["conversationTurns", 24],
            ["conversationChars", 4000],
            ["goalChars", 4000],
            ["requirements", 24],
            ["requirementChars", 4000],
            ["constraints", 24],
            ["constraintChars", 4000],
          ]) {
            const v = ctx[key];
            if (v !== undefined && !(Number.isInteger(v) && v >= 0 && v <= max))
              error(
                `recognition.context.${key}`,
                `must be an integer in [0, ${max}]`,
              );
          }
          if (ctx.plan !== undefined && typeof ctx.plan !== "boolean")
            error("recognition.context.plan", "must be boolean");
          for (const key of Object.keys(ctx))
            if (
              ![
                "profile",
                "conversationTurns",
                "conversationChars",
                "goalChars",
                "requirements",
                "requirementChars",
                "constraints",
                "constraintChars",
                "plan",
              ].includes(key)
            )
              error(`recognition.context.${key}`, "unknown setting");
        }
      }
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
    if (!known.has(key) && !key.startsWith("_")) error(key, UNKNOWN_HINT);
  return issues;
}
