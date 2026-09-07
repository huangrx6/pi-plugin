// Host boundary: reuse Pi's active model and provider/auth resolution.
// The classifier receives a bounded, data-only payload and never gets tools.
import { planRecognitionTuning } from "../../src/core/recognition-tuning.js";


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
  const model = ctx?.model;
  const registry = ctx?.modelRegistry;
  if (!model || typeof registry?.complete !== "function") return null;
  // Provider adaptation planned once from the model metadata: which
  // thinking control (if any) keeps the preflight fast for THIS model.
  const tuning =
    planRecognitionTuning(model, { auto: options.autoTuning !== false }) ??
    undefined;
  return {
    model: `${model.provider ?? "unknown"}/${model.id ?? "unknown"}`,
    tuningNote: tuning?.note,
    async complete({
      systemPrompt,
      payload,
      signal,
      samplingParams,
    }) {
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
      return response?.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    },
  };
}
