import { sanitizeTerminalText, visibleWidth } from "./layout.ts";

type Theme = { fg(color: string, text: string): string };
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
    rows.push(row);
  }
  return rows;
}

/** One item per box. All rows share the same column widths and intersections. */
export function renderGrid(items: readonly string[], requestedWidth: number, theme: Theme): string[] {
  const width = Math.max(0, Math.floor(requestedWidth));
  const clean = items.map(text => sanitizeTerminalText(text)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim()).filter(Boolean);
  if (!width || !clean.length) return [];
  // Below five columns there is no room for borders, padding and content.
  if (width < 5) return clean.flatMap(text => wrap(text, width)).map(line => theme.fg("muted", line));
  const count = Math.min(clean.length, 4, Math.max(1, Math.floor((width - 1) / 39)));
  const inner = width - count - 1;
  const widths = Array.from({ length: count }, (_, i) => Math.floor(inner / count) + (i < inner % count ? 1 : 0));
  const border = (left: string, middle: string, right: string) =>
    theme.fg("dim", left + widths.map(w => "─".repeat(w)).join(middle) + right);
  const vertical = theme.fg("dim", "│");
  const lines = [border("┌", "┬", "┐")];
  for (let offset = 0; offset < clean.length; offset += count) {
    const cells = widths.map((w, i) => wrap(clean[offset + i] ?? "", w - 2));
    const height = Math.max(...cells.map(rows => rows.length));
    for (let row = 0; row < height; row++) {
      lines.push(vertical + cells.map((rows, i) => {
        const value = rows[row] ?? "";
        return theme.fg("muted", " " + value + " ".repeat(widths[i] - 1 - visibleWidth(value)));
      }).join(vertical) + vertical);
    }
    lines.push(offset + count < clean.length ? border("├", "┼", "┤") : border("└", "┴", "┘"));
  }
  return lines;
}
