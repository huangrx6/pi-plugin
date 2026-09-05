/** Grapheme-aware terminal text helpers shared by the footer renderer. */

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const TERMINAL_CONTROL_PATTERN =
  /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[@-_]|\u009d[\s\S]*?(?:\x07|\u009c|$)|\u0090[\s\S]*?(?:\u009c|$)|\u009b[0-?]*[ -/]*[@-~]?)/g;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
  // Some emoji graphemes start with an otherwise narrow code point
  // (for example ©️ and 1️⃣). VS16/keycap presentation still occupies
  // two terminal columns, so inspecting only the first code point is
  // insufficient.
  if (/[\uFE0F\u20E3]|\p{Extended_Pictographic}/u.test(segment)) return 2;
  const code = segment.codePointAt(0) ?? 0;
  // Emoji / pictographic blocks (explicit ranges — see quota conventions).
  if (
    (code >= 0x1f000 && code <= 0x1ffff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2300 && code <= 0x23ff)
  )
    return 2;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;
}

/** Remove terminal escape/control sequences from text supplied by a status. */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(TERMINAL_CONTROL_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/** Visible width of a string that may contain ANSI escapes + CJK. */
export function visibleWidth(text: string): number {
  const clean = text.replace(ANSI_PATTERN, "").replace(/\t/g, "   ");
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean))
    width += graphemeWidth(segment);
  return width;
}

export type Cell = { text: string };

export function makeCell(text: string): Cell {
  return { text };
}
