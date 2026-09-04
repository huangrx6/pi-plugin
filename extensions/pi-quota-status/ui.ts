/** Terminal-safe text and display-width helpers. No Pi runtime imports. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, " ")
    .replace(/\u001b./g, " ")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, char =>
      char === "\n" || char === "\r" || char === "\t" ? " " : "",
    )
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  const code = segment.codePointAt(0) ?? 0;
  if (
    (code >= 0x1f000 && code <= 0x1ffff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2300 && code <= 0x23ff)
  ) return 2;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
    ? 2
    : 1;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(value)) width += graphemeWidth(segment);
  return width;
}

export function truncateToWidth(value: string, maxWidth: number, ellipsis = "…"): string {
  const clean = sanitizeTerminalText(value);
  if (maxWidth <= 0) return "";
  if (displayWidth(clean) <= maxWidth) return clean;
  const suffix = displayWidth(ellipsis) <= maxWidth ? ellipsis : "";
  const target = maxWidth - displayWidth(suffix);
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(clean)) {
    const width = graphemeWidth(segment);
    if (used + width > target) break;
    result += segment;
    used += width;
  }
  return result + suffix;
}
