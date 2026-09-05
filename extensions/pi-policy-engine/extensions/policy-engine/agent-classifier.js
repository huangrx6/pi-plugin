// Host boundary: reuse Pi's active model and provider/auth resolution.
// The classifier receives a bounded, data-only payload and never gets tools.
export function createAgentClassifier(ctx) {
  const model = ctx?.model;
  const registry = ctx?.modelRegistry;
  if (!model || typeof registry?.complete !== "function") return null;
  return {
    model: `${model.provider ?? "unknown"}/${model.id ?? "unknown"}`,
    async complete({ systemPrompt, payload, signal }) {
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
        { signal },
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
