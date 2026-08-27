import type { LooseMessage } from "../types.ts";

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        return block.thinking;
      }
      if (block.type === "toolCall") return JSON.stringify(block.arguments ?? {});
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function estimateMessages(messages: LooseMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + estimateTokens(textFromContent(message.content)) + 8,
    0,
  );
}

export function replaceTextContent(message: LooseMessage, text: string): LooseMessage {
  const content = Array.isArray(message.content)
    ? message.content.filter(
        (part) =>
          !part ||
          typeof part !== "object" ||
          (part as Record<string, unknown>).type !== "text",
      )
    : [];
  return {
    ...message,
    content: [{ type: "text", text }, ...content],
  };
}
