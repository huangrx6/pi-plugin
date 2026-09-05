/**
 * Width helpers (grapheme-aware, ANSI-safe) + the footer layout.
 *
 * A "cell" is one content atom (cwd / branch / one usage stat / model /
 * ONE extension status). `renderTable` lays out one content GROUP per
 * row — environment, usage, context, model, then the status cells —
 * forming a single column of labelled rows. An optional per-row
 * `prefixes` array glues a dim label (e.g. "环境：") to the first line
 * of each row; continuation lines (when a row wraps) are indented to
 * keep the content aligned under the label. Cells within a row are
 * separated by three spaces. Cells wider than the row's effective budget
 * are truncated with an ellipsis.
 *
 * A cell whose text contains `\n` is a multi-line cell: each sub-line
 * renders on its own display row (indented under the label) and is
 * never packed alongside other cells. This lets a status publisher
 * opt into stacked output without the renderer knowing who it is.
 */

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

/** Truncate a possibly-ANSI string to a visible width, keeping escapes.
 *
 *  v0.3.2 bugfix: the inner escape-scan regex MUST carry the `g` flag.
 *  Without it `exec` keeps returning the FIRST escape forever, so any
 *  ANSI-colored text wider than maxWidth (the footer's normal case —
 *  usage cells and extension statuses are theme-colored) infinite-
 *  looped and froze the renderer. */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis = "…",
): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const suffix = visibleWidth(ellipsis) <= maxWidth ? ellipsis : "";
  const target = maxWidth - visibleWidth(suffix);
  let used = 0;
  let cursor = 0;
  let result = "";
  const single = new RegExp(ANSI_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = single.exec(text)) !== null) {
    const plain = text.slice(cursor, m.index);
    for (const { segment } of graphemeSegmenter.segment(plain)) {
      const w = graphemeWidth(segment);
      if (used + w > target) return result + suffix + "\x1b[0m";
      result += segment;
      used += w;
    }
    result += m[0];
    cursor = m.index + m[0].length;
  }
  for (const { segment } of graphemeSegmenter.segment(text.slice(cursor))) {
    const w = graphemeWidth(segment);
    if (used + w > target) break;
    result += segment;
    used += w;
  }
  return result + suffix + "\x1b[0m";
}

export type Cell = { text: string; w: number };

export function makeCell(text: string): Cell {
  return { text, w: visibleWidth(text) };
}

type Theme = { fg(color: string, text: string): string };

/**
 * One content group per row (single column, multiple rows). Within a
 * row, cells are separated by three spaces; a row wider than the terminal
 * greedy-wraps. Cells wider than the row's effective budget are
 * truncated.
 *
 * If `prefixes` is given, it MUST have the same length as `groups`.
 * Each prefix (e.g. "环境：") is rendered dim and glued to the start
 * of its row's first line — separated from the first cell by a
 * two spaces. Continuation lines (when a row wraps) are indented
 * to the same visible width so the content stays aligned under the
 * label. A prefix wider than the terminal leaves the label on its
 * own line.
 */
export function renderTable(
  groups: readonly (readonly Cell[])[],
  width: number,
  theme: Theme,
  prefixes?: readonly string[],
): string[] {
  if (width <= 0 || groups.length === 0) return [];
  const sepText = "   ";
  const sepW = 3;

  const lines: string[] = [];
  groups.forEach((group, gi) => {
    const cells = group.filter((c) => c.w > 0);
    if (cells.length === 0) return;

    const rawPrefix = prefixes?.[gi];
    const prefixW = rawPrefix ? visibleWidth(rawPrefix) + 2 : 0;
    const styledPrefix = rawPrefix ? theme.fg("muted", rawPrefix) : "";
    const indent = prefixW > 0 ? " ".repeat(prefixW) : "";
    const budget = width - prefixW;

    if (budget <= 0) {
      // Extremely narrow terminal: even the label may not fit. Keep the
      // renderer within the width contract instead of overflowing the TUI.
      lines.push(truncateToWidth(styledPrefix, width, ""));
      return;
    }

    // Greedy packing of this group's cells within the budget.
    let current: Cell[] = [];
    let currentW = 0;
    let isFirstLine = true;
    const flush = () => {
      if (current.length === 0) return;
      const joined = current.map((c) => c.text).join(sepText);
      const lead = isFirstLine && rawPrefix ? `${styledPrefix}  ` : indent;
      lines.push(lead + joined);
      current = [];
      currentW = 0;
      isFirstLine = false;
    };
    for (const cell of cells) {
      // Multi-line cell: each sub-line gets its own display row and is
      // never packed with other cells (sub-line width still truncated
      // to the row budget).
      if (cell.text.includes("\n")) {
        flush();
        for (const sub of cell.text.split("\n")) {
          const trimmed = sub.trim();
          if (!trimmed) continue;
          const fitted = makeCell(truncateToWidth(trimmed, budget, "…"));
          const lead = isFirstLine && rawPrefix ? `${styledPrefix}  ` : indent;
          lines.push(lead + fitted.text);
          isFirstLine = false;
        }
        continue;
      }
      const fitted =
        cell.w > budget
          ? makeCell(truncateToWidth(cell.text, budget, "…"))
          : cell;
      const needW = current.length === 0 ? fitted.w : sepW + fitted.w;
      if (currentW + needW > budget && current.length > 0) flush();
      current.push(fitted);
      currentW += current.length === 1 ? fitted.w : sepW + fitted.w;
    }
    flush();
  });
  return lines;
}
