import type { DisplayRow } from "./compose.ts";
import { visibleWidth } from "./layout.ts";
import type { StyleConfig } from "./settings.ts";
import { cleanText, wrapItems } from "./wrapping.ts";

type Theme = { fg(color: string, text: string): string };

function ellipsis(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";
  return `${wrapItems([text], width - 1, 0)[0] || ""}…`;
}

function cellLines(label: string, items: string[], width: number, style: StyleConfig, showLabels: boolean): string[] {
  const heading = showLabels ? `${label}  ` : "";
  const firstWidth = Math.max(1, width - visibleWidth(heading));
  let body = style.overflow === "ellipsis"
    ? [ellipsis(items.join(" ".repeat(style.fieldGap)).replace(/\n/g, " "), firstWidth)]
    : wrapItems(items, firstWidth, style.fieldGap);
  if (style.maxCellLines && body.length > style.maxCellLines) {
    body = body.slice(0, style.maxCellLines);
    body[body.length - 1] = ellipsis(`${body.at(-1) || ""}…`, firstWidth);
  }
  return body.map((line, index) => `${index === 0 ? heading : " ".repeat(visibleWidth(heading))}${line}`);
}

/** Open information bands: natural columns, no cell frames or vertical rules. */
export function renderBands(input: DisplayRow[], requestedWidth: number, style: StyleConfig, theme: Theme, showLabels = true): string[] {
  const width = Number.isFinite(requestedWidth) ? Math.max(0, Math.floor(requestedWidth)) : 0;
  if (!width) return [];
  let rows = input.map(row => row.map(cell => cell ? {
    label: cleanText(cell.label), items: cell.items.map(cleanText).filter(Boolean),
  } : null)).filter(row => row.some(cell => cell?.items.length));
  if (!rows.length) return [];
  const left = Math.floor((width - style.columnGap) * style.leftRatio);
  if (width < style.narrowWidth || Math.min(left, width - style.columnGap - left) < 12) {
    rows = rows.flatMap(row => row.filter(cell => cell?.items.length).map(cell => [cell]));
  }
  const rule = theme.fg(style.borderColor, "─".repeat(width));
  const lines: string[] = [];
  if (style.borders !== "none") lines.push(rule);
  rows.forEach((row, rowIndex) => {
    const widths = row.length === 1 ? [width] : [left, width - style.columnGap - left];
    const cells = row.map((cell, index) => cell?.items.length
      ? cellLines(cell.label, cell.items, widths[index], style, showLabels)
      : []);
    const height = Math.max(...cells.map(value => value.length));
    for (let y = 0; y < height; y++) {
      const line = cells.map((value, index) => {
        const part = value[y] || "";
        return part + " ".repeat(Math.max(0, widths[index] - visibleWidth(part)));
      }).join(" ".repeat(style.columnGap));
      lines.push(theme.fg(style.textColor, line));
    }
    if (style.borders === "all" && rowIndex < rows.length - 1) lines.push(rule);
  });
  if (style.borders !== "none") lines.push(rule);
  return lines;
}
