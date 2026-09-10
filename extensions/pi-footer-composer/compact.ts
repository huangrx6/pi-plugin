import { cleanText, wrap } from "./grid.ts";
import { visibleWidth } from "./layout.ts";

type Tone = "text" | "muted" | "warning" | "error";
type Line = { text: string; tone: Tone };
export type CompactGroup = {
  primary: string;
  primaryTone?: Tone;
  secondary: string;
  statuses: readonly string[];
};
type Theme = { fg(color: string, text: string): string };

/** Fixed semantic columns, bounded reading width, no inner or side borders. */
export function renderCompact(groups: readonly CompactGroup[], requestedWidth: number, theme: Theme): string[] {
  const width = Number.isFinite(requestedWidth) ? Math.max(0, Math.floor(requestedWidth)) : 0;
  if (!width || !groups.length) return [];
  const frameWidth = Math.min(width, 132);
  const inset = frameWidth >= 6 ? 1 : 0;
  const inner = frameWidth - inset * 2;
  const columns = width >= 100;
  const gap = 4;
  const columnWidth = columns ? Math.floor((inner - gap * (groups.length - 1)) / groups.length) : inner;
  const field = (value: string, tone: Tone): Line[] => {
    const clean = cleanText(value);
    return clean ? wrap(clean, columnWidth).map(text => ({ text, tone })) : [];
  };
  const heads = groups.map(group => [
    ...field(group.primary, group.primaryTone || "text"),
    ...field(group.secondary, "muted"),
  ]);
  const tails = groups.map(group => group.statuses.flatMap(value => field(value, "text")));
  const renderLine = (line: Line) => theme.fg(line.tone, line.text);
  const merge = (blocks: Line[][]): string[] => Array.from({ length: Math.max(...blocks.map(block => block.length)) }, (_, row) =>
    " ".repeat(inset) + blocks.map((block, col) => {
      const line = block[row];
      const text = line ? renderLine(line) : "";
      return col === blocks.length - 1 ? text : text + " ".repeat(columnWidth - (line ? visibleWidth(line.text) : 0) + gap);
    }).join("").trimEnd(),
  );
  const content = columns
    ? [...merge(heads), ...(tails.some(block => block.length) ? ["", ...merge(tails)] : [])]
    : heads.flatMap((head, index) => [
      ...(index ? [""] : []),
      ...[...head, ...tails[index]].map(line => " ".repeat(inset) + renderLine(line)),
    ]);
  const rule = theme.fg("dim", "─".repeat(frameWidth));
  return [rule, ...content, rule];
}
