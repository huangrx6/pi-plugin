// Optional semantic classifier fallback for low-confidence cases.
//
// DESIGN §4: deterministic routing is the contract; semantic classification
// is added as a fallback only when the deterministic result is below
// `semanticFallback.confidenceThreshold`. The point is to fix cases where
// keyword matching is too coarse (e.g., "我们现在的 deploy 经常失败" doesn't
// match any debug keyword but semantically is debugging).
//
// Behavior contract:
//   - disabled (default): never invoked, returns null. Zero behavior change.
//   - enabled + confidence >= threshold: returns null. No call made.
//   - enabled + confidence < threshold: invokes the configured endpoint,
//     parses JSON response, merges with the deterministic classification
//     (semantic wins on each field). On ANY error (timeout / network /
//     parse / schema mismatch): returns null and lets the deterministic
//     classification stand. We never block the agent loop on this.
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

const SCHEMA_INSTRUCTIONS = `You are a task classifier for a coding agent.

Given the user prompt below, output a JSON object with EXACTLY these fields:
- taskType: one of "documentation" | "debugging" | "review" | "research" | "architecture" | "coding"
- risk: "low" | "medium" | "high"
- domains: array, any subset of ["database", "kubernetes", "security", "backend", "frontend", "documentation"]
- analysisOnly: boolean (true ONLY if the user explicitly says do-not-modify / review-only / analyze-only)

Deterministic hint (from keyword matching) is provided for context. The prompt may be in any language.
Output JSON only. No prose, no markdown fences.`;

export function buildSemanticPrompt(prompt, deterministic) {
  return JSON.stringify({
    prompt,
    deterministic: {
      taskType: deterministic.taskType,
      risk: deterministic.risk,
      domains: deterministic.domains,
      analysisOnly: deterministic.analysisOnly,
      confidence: deterministic.confidence,
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

function validateSemanticResponse(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const validTask = ["documentation", "debugging", "review", "research", "architecture", "coding"];
  const validRisk = ["low", "medium", "high"];
  if (!validTask.includes(parsed.taskType)) return null;
  if (!validRisk.includes(parsed.risk)) return null;
  if (!Array.isArray(parsed.domains)) return null;
  for (const d of parsed.domains) {
    if (typeof d !== "string") return null;
  }
  if (typeof parsed.analysisOnly !== "boolean") return null;
  return {
    taskType: parsed.taskType,
    risk: parsed.risk,
    domains: parsed.domains,
    analysisOnly: parsed.analysisOnly,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.85,
  };
}

/**
 * @param prompt The raw user prompt.
 * @param classification Output from `classifyTask()`.
 * @param config Effective merged config (defaults + global + project + runtime).
 * @param opts { fetcher?: typeof fetch, now?: () => number }
 * @returns Merged classification if semantic fallback ran successfully, else null.
 *   On null the caller should use the deterministic classification unchanged.
 */
export async function maybeSemanticClassify(prompt, classification, config, opts = {}) {
  const fb = config?.semanticFallback;
  if (!fb || fb.enabled !== true) return null;
  const threshold = typeof fb.confidenceThreshold === "number" ? fb.confidenceThreshold : 0.7;
  if (classification.confidence >= threshold) return null;

  const endpoint = typeof fb.endpoint === "string" ? fb.endpoint : null;
  const model = typeof fb.model === "string" ? fb.model : null;
  if (!endpoint || !model) return null;

  const apiKeyEnv = typeof fb.apiKeyEnvVar === "string" ? fb.apiKeyEnvVar : null;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (!apiKey) return null;

  const fetcher = opts.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") return null;

  const timeoutMs = typeof fb.timeoutMs === "number" ? fb.timeoutMs : 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = buildSemanticRequestBody(model, buildSemanticPrompt(prompt, classification));
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

    // Semantic result wins on each field; we preserve the deterministic
    // `reasons` so /policy why remains auditable.
    return {
      ...classification,
      ...validated,
      reasons: [
        ...(classification.reasons ?? []),
        `semantic-fallback: taskType=${validated.taskType} risk=${validated.risk} confidence=${validated.confidence}`,
      ],
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
