// Preserve offsets while excluding quoted examples from execution decisions.
export function unquotedText(input) {
  return String(input ?? "").replace(
    /```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu,
    (span) => span.replace(/[^\n]/g, " "),
  );
}

export function isConversation(prompt) {
  return /^(?:你好|您好|嗨|哈喽|早上好|晚上好|谢谢(?:你)?|多谢|辛苦了|再见|hello|hi|hey|thanks|thank you)[\s。.!！~～]*$/i.test(
    String(prompt ?? "").trim(),
  );
}
