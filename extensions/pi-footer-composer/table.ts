import { cleanText, wrap, wrapItems } from "./wrapping.ts";
import { visibleWidth } from "./layout.ts";
import type { DisplayRow } from "./compose.ts";
import type { StyleConfig } from "./settings.ts";
type Theme = { fg(color: string, text: string): string };

function ellipsis(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";
  return (wrap(text, width - 1)[0] || "") + "…";
}
function content(items: string[], width: number, style: StyleConfig): string[] {
  let lines = style.overflow === "ellipsis" ? [ellipsis(items.join(" ".repeat(style.fieldGap)).replace(/\n/g, " "), width)] : wrapItems(items, width, style.fieldGap);
  if (style.maxCellLines && lines.length > style.maxCellLines) {
    lines = lines.slice(0, style.maxCellLines);
    const last = lines.at(-1) || "";
    lines[lines.length - 1] = ellipsis(last + "…", width);
  }
  return lines;
}
/** A one-cell row spans the width; a two-cell row uses the configured split. */
export function renderTable(input: DisplayRow[], requestedWidth: number, style: StyleConfig, theme: Theme, showLabels = true): string[] {
  const width = Number.isFinite(requestedWidth) ? Math.max(0, Math.floor(requestedWidth)) : 0;
  if (!width) return [];
  let rows = input.map(row => row.map(cell => cell ? { label: cleanText(cell.label), items: cell.items.map(cleanText).filter(Boolean) } : null))
    .filter(row => row.some(cell => cell?.items.length));
  const labelWidth = showLabels ? Math.max(style.labelWidth, ...rows.flat().map(cell => visibleWidth(cell?.label || ""))) : 0;
  if (!rows.length) return [];
  const divider = labelWidth + 2;
  const labelDivider = showLabels && style.labelDivider;
  const prefix = showLabels ? divider + (labelDivider ? 2 : 1) : 1;
  const left = Math.floor((width - style.columnGap) * style.leftRatio);
  if (width < style.narrowWidth || Math.min(left, width - style.columnGap - left) - prefix < 2) {
    rows = rows.flatMap(row => row.filter(cell => cell?.items.length).map(cell => [cell]));
  }
  if (width - prefix < 2) {
    return rows.flatMap(row => row.flatMap(cell => cell ? content([`${cell.label} ${cell.items.join(" ".repeat(style.fieldGap))}`], width, style) : []))
      .map(line => theme.fg(style.textColor, line));
  }
  const plans = rows.map(row => {
    const widths = row.length === 1 ? [width] : [left, width - style.columnGap - left];
    const starts = row.length === 1 ? [0] : [0, left + style.columnGap];
    const dividers = labelDivider ? starts.map(start => start + divider) : [];
    const gap = row.length === 1 ? [] : Array.from({ length: style.columnGap }, (_, i) => left + i);
    return { row, widths, dividers, gap };
  });
  type Plan = typeof plans[number];
  const rule = (prev?: Plan, next?: Plan) => theme.fg(style.borderColor, Array.from({ length: width }, (_, i) => {
    const above = prev?.dividers.includes(i), below = next?.dividers.includes(i);
    if (above || below) return above && below ? "┼" : above ? "┴" : "┬";
    if ((!prev || prev.gap.includes(i)) && (!next || next.gap.includes(i))) return " ";
    return "─";
  }).join(""));
  const lines: string[] = [];
  if (style.borders !== "none") lines.push(rule(undefined, plans[0]));
  plans.forEach((plan, index) => {
    const contents = plan.row.map((cell, side) => cell?.items.length ? content(cell.items, plan.widths[side] - prefix, style) : []);
    const height = Math.max(...contents.map(lines => lines.length));
    for (let y = 0; y < height; y++) {
      lines.push(plan.row.map((cell, side) => {
        const label = showLabels && y === 0 && cell?.items.length ? cell.label : "";
        const value = contents[side][y] || "";
        const heading = showLabels ? ` ${label}${" ".repeat(labelWidth - visibleWidth(label) + 1)}` : "";
        return theme.fg(style.textColor, heading) +
          (labelDivider ? theme.fg(style.borderColor, "│") : "") +
          theme.fg(style.textColor, ` ${value}${" ".repeat(plan.widths[side] - prefix - visibleWidth(value))}`);
      }).join(" ".repeat(style.columnGap)));
    }
    if (style.borders === "all" || (index === plans.length - 1 && style.borders === "outer")) lines.push(rule(plan, plans[index + 1]));
  });
  return lines;
}
