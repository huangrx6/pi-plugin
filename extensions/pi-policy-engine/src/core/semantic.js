// Optional semantic classifier fallback for low-confidence cases.
//
// DESIGN §4: deterministic routing is the contract; semantic classification
// is added as a fallback only when the deterministic result is below
// `semanticFallback.confidenceThreshold`. The point is to fix cases where
// keyword matching is too coarse (e.g., "我们现在的 deploy 经常失败" doesn't
// match any debug keyword but semantically is debugging).
//
// v0.16 CONSERVATIVE MERGE — the semantic model arbitrates AMBIGUITY, it
// can never override deterministic hard evidence (principle #3):
//   taskType         semantic may arbitrate (it only runs below threshold)
//   domains          deterministic always kept; semantic may ADD extras,
//                    enum-validated, capped at max(2, deterministic count)
//   risk             max(deterministic, semantic) — can only go UP
//   executionIntent  locked unless deterministic said "unclear"
//   confidence       deterministic value kept — the model does not get to
//                    self-report confidence; the engine keeps its own number
//
// Behavior contract:
//   - disabled (default): never invoked, returns null. Zero behavior change.
//   - enabled + confidence >= threshold: returns null. No call made.
//   - enabled + confidence < threshold: invokes the configured endpoint,
//     parses JSON response, conservative-merges with the deterministic
//     classification. On ANY error (timeout / network / parse / schema
//     mismatch): returns null and the deterministic classification stands.
//     We never block the agent loop on this.
//
// Configuration:
//   semanticFallback: {
//     enabled: boolean,
//     endpoint: "https://api.openai.com/v1/chat/completions",
//     model: "gpt-4o-mini",
//     apiKeyEnvVar: "OPENAI_API_KEY",   // read at call time, never persisted
//     confidenceThreshold: 0.7,
//     timeoutMs: 4000,
//   }
//
// Testing:
//   Pass `fetcher` in opts to override the HTTP call (returns the raw Response-
//   shaped object). Pass `now` to override Date.now for timeout logic.

const DOMAIN_ENUM = [
  "database",
  "kubernetes",
  "backend",
  "frontend",
  "documentation",
];

const TASK_ENUM = [
  "documentation",
  "debugging",
  "review",
  "research",
  "architecture",
  "coding",
];

const RISK_ENUM = ["low", "medium", "high"];
const INTENT_ENUM = ["read-only", "mutate", "unclear"];
const RISK_RANK = { low: 0, medium: 1, high: 2 };

const SCHEMA_INSTRUCTIONS = `You are a task classifier for a coding agent.

Given the user prompt below, output a JSON object with EXACTLY these fields:
- taskType: one of "documentation" | "debugging" | "review" | "research" | "architecture" | "coding"
- risk: "low" | "medium" | "high"
- domains: array, any subset of ["database", "kubernetes", "backend", "frontend", "documentation"]
- executionIntent: one of "read-only" | "mutate" | "unclear"

Deterministic hint (from keyword matching) is provided for context. The prompt may be in any language.
Output JSON only. No prose, no markdown fences.`;

export function buildSemanticPrompt(prompt, deterministic) {
  return JSON.stringify({
    prompt,
    deterministic: {
      taskType: deterministic.taskType,
      risk: deterministic.risk,
      domains: deterministic.domains,
      executionIntent: deterministic.executionIntent,
    },
  });
}

export function buildSemanticRequestBody(model, userJsonPayload) {
  return {
    model,
    messages: [
      { role: "system", content: SCHEMA_INSTRUCTIONS },
      { role: "user", content: userJsonPayload },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  };
}

/**
 * Schema-validate the parsed model response. Unknown enum values are fatal;
 * domains are filtered to the known enum (an LLM hallucinating "made-up"
 * domains must not reach the merge).
 */
function validateSemanticResponse(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!TASK_ENUM.includes(parsed.taskType)) return null;
  if (!RISK_ENUM.includes(parsed.risk)) return null;
  if (!Array.isArray(parsed.domains)) return null;
  const domains = [
    ...new Set(parsed.domains.filter((d) => DOMAIN_ENUM.includes(d))),
  ];
  const executionIntent =
    parsed.executionIntent !== undefined &&
    INTENT_ENUM.includes(parsed.executionIntent)
      ? parsed.executionIntent
      : undefined;
  return {
    taskType: parsed.taskType,
    risk: parsed.risk,
    domains,
    executionIntent,
  };
}

/**
 * Conservative merge: semantic resolves ambiguity, never hard evidence.
 * See module header for the per-field rules.
 */
function conservativeMerge(deterministic, semantic, opts = {}) {
  const reasons = [...(deterministic.reasons ?? [])];
  const notes = [
    `semantic-fallback: taskType=${semantic.taskType} risk=${semantic.risk}`,
  ];

  const merged = {
    ...deterministic,
    taskType: semantic.taskType,
  };
  if (semantic.taskType !== deterministic.taskType) {
    notes.push(
      `taskType arbitrated ${deterministic.taskType} → ${semantic.taskType}`,
    );
  }

  // Risk can only go UP.
  const risk =
    RISK_RANK[semantic.risk] > RISK_RANK[deterministic.risk]
      ? semantic.risk
      : deterministic.risk;
  if (risk !== deterministic.risk) {
    notes.push(`risk raised ${deterministic.risk} → ${risk} (never lowered)`);
  }
  merged.risk = risk;

  // Domains: deterministic always kept; semantic adds enum-valid extras
  // up to the cap. Never drops a deterministic domain.
  // v0.21: the cap honors config.maxDomains — it was hardcoded ≥2, so a
  // maxDomains:1 config could still end up with two domains after merge.
  const cap = Math.max(
    1,
    Number.isFinite(Number(opts.maxDomains)) && Number(opts.maxDomains) > 0
      ? Number(opts.maxDomains)
      : 2,
    deterministic.domains?.length ?? 0,
  );
  const domains = [
    ...new Set([...(deterministic.domains ?? []), ...semantic.domains]),
  ];
  const capped = domains.slice(0, cap);
  if (capped.length > (deterministic.domains?.length ?? 0)) {
    notes.push(
      `domains extended by semantic: ${capped
        .filter((d) => !(deterministic.domains ?? []).includes(d))
        .join(", ")}`,
    );
  }
  merged.domains = capped;

  // Intent is locked unless deterministic was unclear.
  if (deterministic.executionIntent === "unclear" && semantic.executionIntent) {
    merged.executionIntent = semantic.executionIntent;
    notes.push(
      `executionIntent resolved unclear → ${semantic.executionIntent}`,
    );
  } else {
    merged.executionIntent = deterministic.executionIntent;
  }

  // Confidence stays the engine's own (deterministic) number.
  merged.confidence = deterministic.confidence;

  // v0.21 P1: invariant re-run. The deterministic classifier guarantees
  // task-based risk floors (architecture → high); semantic taskType
  // arbitration must not silently break them. All floors applied here, in
  // ONE place, after the merge — never scattered per-field.
  const RISK_FLOOR_BY_TASK = { architecture: "high" };
  const floor = RISK_FLOOR_BY_TASK[merged.taskType];
  if (floor && RISK_RANK[merged.risk] < RISK_RANK[floor]) {
    notes.push(
      `risk raised ${merged.risk} → ${floor} by task invariant (${merged.taskType} floor re-applied post-merge)`,
    );
    merged.risk = floor;
  }

  merged.reasons = [...reasons, notes.join("; ")];
  return merged;
}

/**
 * @param prompt The raw user prompt.
 * @param classification Output from `classifyTask()`.
 * @param config Effective merged config (defaults + global + project + runtime).
 * @param opts { fetcher?: typeof fetch, now?: () => number }
 * @returns Merged classification if semantic fallback ran successfully, else null.
 *   On null the caller should use the deterministic classification unchanged.
 */
export async function maybeSemanticClassify(
  prompt,
  classification,
  config,
  opts = {},
) {
  const fb = config?.semanticFallback;
  if (!fb || fb.enabled !== true) return null;
  const threshold =
    typeof fb.confidenceThreshold === "number" ? fb.confidenceThreshold : 0.7;
  if (classification.confidence >= threshold) return null;

  const endpoint = typeof fb.endpoint === "string" ? fb.endpoint : null;
  const model = typeof fb.model === "string" ? fb.model : null;
  if (!endpoint || !model) return null;

  const apiKeyEnv =
    typeof fb.apiKeyEnvVar === "string" ? fb.apiKeyEnvVar : null;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (!apiKey) return null;

  const fetcher = opts.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") return null;

  const timeoutMs = typeof fb.timeoutMs === "number" ? fb.timeoutMs : 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = buildSemanticRequestBody(
      model,
      buildSemanticPrompt(prompt, classification),
    );
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const validated = validateSemanticResponse(parsed);
    if (!validated) return null;

    return conservativeMerge(classification, validated, {
      maxDomains: Number(fb.maxDomains ?? config?.maxDomains ?? 2),
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
