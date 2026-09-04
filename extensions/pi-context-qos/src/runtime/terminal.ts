const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[()][0-2A-Za-z]|[=>])/g;
const UNSAFE_CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/** Preserve line breaks while neutralizing terminal and bidi controls. */
export function sanitizeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(TERMINAL_SEQUENCE, "")
    .replace(/\x1b/g, "")
    .replace(UNSAFE_CONTROLS, "");
}

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  const code = segment.codePointAt(0) ?? 0;
  if (/\p{Extended_Pictographic}/u.test(segment)) return 2;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;
}

export function displayWidth(value: unknown): number {
  let width = 0;
  for (const { segment } of graphemes.segment(sanitizeTerminalText(value))) {
    if (segment !== "\n") width += graphemeWidth(segment);
  }
  return width;
}

export function wrapTerminalText(value: unknown, requestedWidth: number): string[] {
  const width = Math.max(1, Math.floor(Number(requestedWidth) || 1));
  const output: string[] = [];
  for (const logicalLine of sanitizeTerminalText(value).split("\n")) {
    let row = "";
    let used = 0;
    for (const { segment } of graphemes.segment(logicalLine)) {
      const segmentWidth = graphemeWidth(segment);
      if (segmentWidth > width) {
        if (row) output.push(row);
        output.push("…");
        row = "";
        used = 0;
        continue;
      }
      if (row && used + segmentWidth > width) {
        output.push(row);
        row = "";
        used = 0;
      }
      row += segment;
      used += segmentWidth;
    }
    output.push(row);
  }
  return output;
}

export function truncateTerminalText(value: unknown, requestedWidth: number): string {
  const width = Math.max(0, Math.floor(Number(requestedWidth) || 0));
  if (width === 0) return "";
  const clean = sanitizeTerminalText(value).replace(/\n/g, " ");
  if (displayWidth(clean) <= width) return clean;
  const target = Math.max(0, width - 1);
  let output = "";
  let used = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const segmentWidth = graphemeWidth(segment);
    if (used + segmentWidth > target) break;
    output += segment;
    used += segmentWidth;
  }
  return output + "…";
}
