/**
 * Width helpers (grapheme-aware, ANSI-safe) + the table layout.
 *
 * A "cell" is one content atom (cwd / branch / one usage stat / model /
 * ONE extension status). `renderTable` greedily packs cells into rows
 * separated by a dim `│`; a row wraps when the next cell would overflow
 * the terminal width. Narrow terminals naturally get more, shorter rows;
 * wide terminals get fewer, longer rows. An over-height table is capped
 * at MAX_ROWS with a `+N` overflow cell so the footer never crowds the
 * editor.
 */

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemeWidth(segment: string): number {
  if (/^\p{Mark}+$/u.test(segment)) return 0;
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

/** Visible width of a string that may contain ANSI escapes + CJK. */
export function visibleWidth(text: string): number {
  const clean = text.replace(ANSI_PATTERN, "").replace(/\t/g, "   ");
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean))
    width += graphemeWidth(segment);
  return width;
}

/** Truncate a possibly-ANSI string to a visible width, keeping escapes. */
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
  ANSI_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  const single = new RegExp(ANSI_PATTERN.source);
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

/** Hard cap so a status-heavy session cannot push the editor off-screen. */
export const MAX_ROWS = 4;

type Theme = { fg(color: string, text: string): string };

/**
 * Pack cells into rows and render them as a pipe table.
 * Cells wider than the whole terminal are truncated to fit alone.
 */
export function renderTable(cells: readonly Cell[], width: number, theme: Theme): string[] {
  if (width <= 0) return [];
  const sepText = theme.fg("dim", " │ ");
  const sepW = 3;

  const rows: Cell[][] = [];
  let current: Cell[] = [];
  let currentW = 0;
  for (const cell of cells) {
    const needW = current.length === 0 ? cell.w : sepW + cell.w;
    if (currentW + needW > width && current.length > 0) {
      rows.push(current);
      current = [];
      currentW = 0;
    }
    const fitted =
      cell.w > width
        ? makeCell(truncateToWidth(cell.text, width, "…"))
        : cell;
    current.push(fitted);
    currentW += current.length === 1 ? fitted.w : sepW + fitted.w;
  }
  if (current.length > 0) rows.push(current);

  if (rows.length > MAX_ROWS) {
    const dropped = rows.slice(MAX_ROWS - 1).reduce((n, r) => n + r.length, 0);
    const kept = rows.slice(0, MAX_ROWS - 1);
    kept.push([makeCell(theme.fg("dim", `…+${dropped}`))]);
    rows.length = 0;
    rows.push(...kept);
  }

  return rows.map((row) => row.map((c) => c.text).join(sepText));
}
