// Provider payload helpers. Keep this module independent from Pi runtime APIs.
export const POLICY_PAYLOAD_MARKER = "<pi-policy-engine-policy>";

function withPolicy(text, policyBlock) {
  const value = String(text ?? "");
  if (value.includes(POLICY_PAYLOAD_MARKER)) return value;
  return `${value}\n\n${POLICY_PAYLOAD_MARKER}\n${policyBlock}\n</pi-policy-engine-policy>`;
}

function appendContent(content, policyBlock) {
  if (typeof content === "string") return withPolicy(content, policyBlock);
  if (Array.isArray(content)) {
    return [
      ...content,
      { type: "text", text: withPolicy("", policyBlock).trimStart() },
    ];
  }
  return withPolicy("", policyBlock).trimStart();
}

/**
 * Add the per-turn policy to the provider request without persisting it as a
 * chat message. Pi exposes provider-specific payloads here, so support the
 * common `messages`, `system`, and `instructions` shapes used by its adapters.
 */
export function appendPolicyToProviderPayload(payload, policyBlock) {
  if (!payload || typeof payload !== "object" || !policyBlock) return payload;
  if (typeof payload.system === "string")
    return { ...payload, system: withPolicy(payload.system, policyBlock) };
  if (Array.isArray(payload.system))
    return {
      ...payload,
      system: [
        ...payload.system,
        { type: "text", text: withPolicy("", policyBlock).trimStart() },
      ],
    };
  if (typeof payload.instructions === "string")
    return {
      ...payload,
      instructions: withPolicy(payload.instructions, policyBlock),
    };
  if (Array.isArray(payload.messages)) {
    const messages = payload.messages.map((message) => ({ ...message }));
    const systemIndex = messages.findIndex((message) => message?.role === "system");
    if (systemIndex >= 0) {
      messages[systemIndex].content = appendContent(
        messages[systemIndex].content,
        policyBlock,
      );
    } else {
      messages.unshift({
        role: "system",
        content: withPolicy("", policyBlock).trimStart(),
      });
    }
    return { ...payload, messages };
  }
  return payload;
}
