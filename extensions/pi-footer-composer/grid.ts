import { sanitizeTerminalText, visibleWidth } from "./layout.ts";

type Theme = { fg(color: string, text: string): string };
type GridRow = { label: string; items: readonly string[] };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap complete graphemes; status text is untrusted, styling belongs here. */
function wrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let row = "";
    let used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const size = visibleWidth(segment);
      if (used + size > width && row) { rows.push(row); row = ""; used = 0; }
      if (size > width) { rows.push("…"); continue; }
      row += segment;
      used += size;
    }
    if (row || !line) rows.push(row);
  }
  return rows;
}

function cleanText(text: string): string {
  return sanitizeTerminalText(text)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim();
}

/** Keep fields together when possible; long or multiline fields wrap in place. */
function wrapItems(items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    if (!item.includes("\n") && visibleWidth(item) <= width) {
      if (current && visibleWidth(current) + 3 + visibleWidth(item) <= width) {
        current += `   ${item}`;
      } else {
        if (current) lines.push(current);
        current = item;
      }
    } else {
      if (current) lines.push(current);
      lines.push(...wrap(item, width));
      current = "";
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** One category per row, one fixed divider, no left or right outer border. */
export function renderGrid(rows: readonly GridRow[], requestedWidth: number, theme: Theme): string[] {
  const width = Number.isFinite(requestedWidth) ? Math.max(0, Math.floor(requestedWidth)) : 0;
  const clean = rows.map(row => ({
    label: cleanText(row.label).replace(/\n/g, " "),
    items: row.items.map(cleanText).filter(Boolean),
  })).filter(row => row.items.length);
  if (!width || !clean.length) return [];
  const labelWidth = Math.max(...clean.map(row => visibleWidth(row.label)));
  const dividerColumn = labelWidth + 2;
  const contentWidth = width - dividerColumn - 2;
  // Keep room for a wide grapheme; tiny terminals fall back to plain lines.
  if (contentWidth < 2) {
    return clean.flatMap(row => wrap(`${row.label}  ${row.items.join("   ")}`, width))
      .map(line => theme.fg("muted", line));
  }
  const border = (junction: string) =>
    theme.fg("dim", "─".repeat(dividerColumn) + junction + "─".repeat(width - dividerColumn - 1));
  const vertical = theme.fg("dim", "│");
  const lines = [border("┬")];
  for (const [index, row] of clean.entries()) {
    const content = wrapItems(row.items, contentWidth);
    for (const [lineIndex, value] of content.entries()) {
      const label = lineIndex === 0 ? row.label : "";
      lines.push(
        theme.fg("muted", " " + label + " ".repeat(labelWidth - visibleWidth(label) + 1)) +
        vertical + theme.fg("muted", " " + value + " ".repeat(contentWidth - visibleWidth(value))),
      );
    }
    lines.push(border(index === clean.length - 1 ? "┴" : "┼"));
  }
  return lines;
}
