// Host boundary: reuse Pi's active model and provider/auth resolution.
// The classifier receives a bounded, data-only payload and never gets tools.
import { planRecognitionTuning } from "../../src/core/recognition-tuning.js";

/** Parse a "provider/id" override into a Model from the registry.
 *  Returns null when the override is absent or unresolvable — the
 *  caller falls back to the active model and says so in diagnostics. */
function resolveModelOverride(registry, override) {
  if (typeof override !== "string" || !override.includes("/")) return null;
  const slash = override.indexOf("/");
  const provider = override.slice(0, slash);
  const id = override.slice(slash + 1);
  if (!provider || !id) return null;
  try {
    return registry?.find?.(provider, id) ?? null;
  } catch {
    return null;
  }
}

/** Options handed to registry.complete: the tuning plan expressed
 *  through the two channels pi-ai honours — samplingParams merged
 *  as-is into openai-completions request bodies (auto patch first,
 *  the caller's recognition.requestBody last, so user keys win), and
 *  reasoningEffort through the standard adapter channel (undefined
 *  means thinkingFormat adapters disable thinking). An empty merge
 *  omits the key entirely so providers never see a stray {}. */
function buildCompleteOptions(signal, tuning, userSamplingParams) {
  const options = { signal, reasoningEffort: tuning?.reasoningEffort };
  const merged = { ...tuning?.samplingPatch, ...userSamplingParams };
  if (Object.keys(merged).length > 0) options.samplingParams = merged;
  return options;
}

export function createAgentClassifier(ctx, options = {}) {
  const registry = ctx?.modelRegistry;
  if (!registry || typeof registry.complete !== "function") return null;
  // A recognition.model override ("provider/id") lets the user run the
  // preflight on a cheap configured model while the session keeps the
  // expensive primary; unresolvable overrides fall back to the active
  // model with a diagnostic note.
  const override =
    resolveModelOverride(registry, options.modelOverride) ?? null;
  const model = override ?? ctx?.model;
  if (!model) return null;
  const usingOverride = Boolean(override);
  // Provider adaptation planned once from the model metadata: which
  // thinking control (if any) keeps the preflight fast for THIS model.
  const tuning =
    planRecognitionTuning(model, { auto: options.autoTuning !== false }) ??
    undefined;
  return {
    model: `${model.provider ?? "unknown"}/${model.id ?? "unknown"}`,
    usingOverride,
    tuningNote: tuning?.note,
    async complete({ systemPrompt, payload, signal, samplingParams }) {
      const response = await registry.complete(
        model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: payload }],
              timestamp: Date.now(),
            },
          ],
        },
        buildCompleteOptions(signal, tuning, samplingParams),
      );
      if (["error", "aborted"].includes(response?.stopReason))
        throw new Error("Agent classification failed");
      const text = response?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      // Real token usage from the provider, when reported: surfaced in
      // the activity card and persisted into the routing history so
      // the profile can be tuned from actual measurements later.
      const usage = response?.usage;
      const usageTokens =
        usage &&
        Number.isFinite(usage.input) &&
        Number.isFinite(usage.output)
          ? { input: usage.input, output: usage.output }
          : null;
      return { text, usageTokens };
    },
  };
}
