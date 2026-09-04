const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// CSI, OSC, DCS, SOS, PM and APC sequences. A trailing standalone ESC is
// removed separately so incomplete sequences cannot reach the terminal.
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[()][0-2A-Za-z]|[=>])/g;
const UNSAFE_CONTROLS = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/** Preserve useful newlines while removing terminal and bidi controls. */
export function sanitizeTerminalText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(TERMINAL_SEQUENCE, "")
    .replace(/\x1b/g, "")
    .replace(UNSAFE_CONTROLS, "");
}

function graphemeWidth(segment) {
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

export function displayWidth(value) {
  let width = 0;
  for (const { segment } of graphemes.segment(sanitizeTerminalText(value))) {
    if (segment === "\n") continue;
    width += graphemeWidth(segment);
  }
  return width;
}

/** Wrap plain terminal text without splitting CJK, emoji or combining text. */
export function wrapTerminalText(value, requestedWidth) {
  const width = Math.max(1, Math.floor(Number(requestedWidth) || 1));
  const output = [];
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
