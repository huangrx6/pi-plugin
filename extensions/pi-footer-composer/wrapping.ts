import { sanitizeTerminalText, visibleWidth } from "./layout.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap complete graphemes; status text is untrusted, styling belongs here. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
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

export function cleanText(text: string): string {
  return sanitizeTerminalText(text)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim();
}

