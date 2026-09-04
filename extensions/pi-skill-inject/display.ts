const TERMINAL_CONTROL_PATTERN =
  /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[@-_]|\u009d[\s\S]*?(?:\x07|\u009c|$)|\u0090[\s\S]*?(?:\u009c|$)|\u009b[0-?]*[ -/]*[@-~]?)/g;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  if (/[\uFE0F\u20E3]|\p{Extended_Pictographic}/u.test(segment)) return 2;
  const code = segment.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f000 && code <= 0x1ffff)
    ? 2
    : 1;
}

export function sanitizeInline(value: unknown): string {
  return String(value ?? "")
    .replace(TERMINAL_CONTROL_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateInline(value: unknown, maxWidth: number): string {
  const clean = sanitizeInline(value);
  let total = 0;
  for (const { segment } of segmenter.segment(clean)) total += graphemeWidth(segment);
  if (total <= maxWidth) return clean;
  const target = Math.max(0, maxWidth - 1);
  let used = 0;
  let result = "";
  for (const { segment } of segmenter.segment(clean)) {
    const width = graphemeWidth(segment);
    if (used + width > target) break;
    result += segment;
    used += width;
  }
  return `${result}…`;
}

export function loadedSkillsText(names: readonly string[]): string {
  if (names.length === 0) return "本分支尚未加载技能。";
  return [
    `已加载技能 · ${names.length}`,
    ...names.map((name) => `  · ${truncateInline(name, 72)}`),
  ].join("\n");
}
