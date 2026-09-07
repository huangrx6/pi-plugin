// Host boundary: reuse Pi's active model and provider/auth resolution.
// The classifier receives a bounded, data-only payload and never gets tools.
export function createAgentClassifier(ctx) {
  const model = ctx?.model;
  const registry = ctx?.modelRegistry;
  if (!model || typeof registry?.complete !== "function") return null;
  return {
    model: `${model.provider ?? "unknown"}/${model.id ?? "unknown"}`,
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
        // samplingParams is merged as-is into openai-completions request
        // bodies (last, so overrides win), letting callers pass provider-
        // specific switches such as thinking mode without touching the
        // model catalogue. Providers without support ignore or reject
        // them; that choice belongs to recognition.requestBody config.
        { signal, samplingParams },
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
