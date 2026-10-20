import { cacheHit, outputRate, usageTotal } from "./data.ts";
import { visibleWidth } from "./layout.ts";
import { cleanText, wrap, wrapWords } from "./wrapping.ts";
import type { FooterConfig, PanelId } from "./settings.ts";
import type { Snapshot } from "./types.ts";
type Rgb = { kind: "rgb"; r: number; g: number; b: number };
export type Theme = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  getThinkingBorderColor?(level: string): (text: string) => string;
  appearance?: "dark" | "light";
  style?(text: string, options: { bg?: Rgb; fg?: Rgb }): string;
};
export type Hit = { id: PanelId; x: number; width: number };
export function compactNumber(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1e6) return `${Number((value / 1000).toFixed(value < 10000 ? 1 : 0))}K`;
  return `${Number((value / 1e6).toFixed(value < 1e7 ? 1 : 0))}M`;
}
export function duration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const safe = cleanText(text).replace(/\n/g, " ");
  if (visibleWidth(safe) <= width) return safe;
  if (width === 1) return "…";
  return `${wrap(safe, width - 1)[0] ?? ""}…`;
}
const percent = (n: number | null | undefined) => typeof n === "number" ? `${Number(n.toFixed(1))}%` : "--";
export function summary(s: Snapshot, config: FooterConfig, width: number, active: PanelId | null, theme: Theme): { line: string; hits: Hit[] } {
  const rate = outputRate(s), hit = cacheHit(s), ctx = s.context?.percent == null ? "--" : `${Math.round(s.context.percent)}%`;
  const speed = s.waitingMs !== null ? `等待 ${(s.waitingMs / 1000).toFixed(1)}s` : rate === null ? "-- tok/s" : `${Math.round(rate)} tok/s`;
  const [a, b, c] = config.icons === "ascii" ? ["S", "T", "C"] : ["◴", "▱", "◔"];
  const profiles: [string, string, string][] = [
    [`${a} ${s.rounds} 轮 ${s.steps} 步 · ${speed}`, `${b} ${compactNumber(usageTotal(s))} tok · 缓存命中 ${hit === null ? "--" : `${Math.round(hit)}%`}`, `${c} ${ctx}`],
    [`${a} ${s.rounds}轮${s.steps}步 · ${speed}`, `${b} ${compactNumber(usageTotal(s))} tok`, `${c} ${ctx}`],
    [`${a} ${s.steps}步`, `${b} ${compactNumber(usageTotal(s))}`, `${c} ${ctx}`],
    [a, b, c],
  ];
  const moreLabel = config.icons === "ascii" ? "..." : "···", gap = " ".repeat(config.style.gap);
  const parts = profiles.find(p => visibleWidth([...p, moreLabel].join(gap)) <= width) ?? [];
  const ids: PanelId[] = ["stats", "tokens", "context", "more"];
  const values = parts.length ? [...parts, moreLabel] : [width >= 3 ? moreLabel : ".".repeat(Math.max(0, width))];
  const hits: Hit[] = []; let x = 0;
  const painted = values.map((value, i) => {
    const id = parts.length ? ids[i] : "more", size = visibleWidth(value);
    hits.push({ id, x, width: size }); x += size + gap.length;
    // 只提亮当前入口，保持原位与原宽；不借用消息或选择控件的背景。
    return theme.fg(active === id ? "text" : config.style.textColor, value);
  });
  return { line: painted.join(gap), hits };
}
type Tone = "label" | "value" | "note" | "rule";
type Span = { text: string; tone: Tone };
export type PanelRow = Span[];
export type Panel = { title: string; total?: string; rows: PanelRow[] };
const span = (text: string, tone: Tone): Span => ({ text, tone });
const rowText = (row: PanelRow) => row.map(part => part.text).join("");
/** Dialog fallback and tests use the same content as the styled card. */
export function panelText(panel: Panel): string {
  return [panel.total ?? "", ...panel.rows.map(rowText)].filter(Boolean).join("\n");
}
function pair(label: string, value: string, width: number): PanelRow[] {
  const safe = cleanText(value), labelWidth = visibleWidth(label);
  if (!safe.includes("\n") && labelWidth + visibleWidth(safe) + 3 <= width) {
    return [[span(label, "label"), span(" ".repeat(width - labelWidth - visibleWidth(safe)), "label"), span(safe, "value")]];
  }
  // 所有续行沿同一右边界对齐；空间足够时，标签与第一行值共用一行。
  const beside = width - labelWidth - 3 >= 12;
  const available = beside ? width - labelWidth - 3 : width;
  const details = safe.split("\n").flatMap(line => {
    // 只识别文本的排版分隔，不解释额度/诊断等发布者的语义或数值。
    const parts = visibleWidth(line) > available ? line.split(/\s*[·|•]\s*|(?<=\))\s+|\s{2,}/u) : [line];
    return parts.flatMap(part => wrapWords(part, available));
  });
  const rows: PanelRow[] = beside ? [] : wrapWords(label, width).map(text => [span(text, "label")]);
  details.forEach((text, index) => {
    const left = beside && index === 0 ? label : "";
    rows.push([span(left, "label"), span(" ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(text))), "label"), span(text, "value")]);
  });
  return rows;
}
function spacedRows(rows: PanelRow[]): PanelRow[] {
  const spaced: PanelRow[] = [];
  for (const row of rows) {
    if (spaced.length && spaced.at(-1)!.length && row.length) spaced.push([]);
    if (row.length || spaced.at(-1)?.length) spaced.push(row);
  }
  while (spaced.length && !spaced.at(-1)!.length) spaced.pop();
  return spaced;
}
export function panelContent(id: PanelId, s: Snapshot, config: FooterConfig, statuses: ReadonlyMap<string, string>, width: number): Panel {
  const rows: PanelRow[] = [];
  const add = (label: string, value: string) => rows.push(...pair(label, value, width));
  const note = (text: string) => rows.push(...wrapWords(text, width).map(line => [span(line, "note")]));
  const exact = (n: number) => `${Math.round(n).toLocaleString("en-US")} tok`, m = s.metrics;
  if (id === "stats") {
    add("模型用时", m.calls > m.failed ? duration(m.llmMs) : "—");
    add("工具用时", m.tools > 0 ? duration(m.toolMs) : "—");
    add("首 Token 平均", m.ttftCount ? duration(m.ttftMs / m.ttftCount) : "—");
    add("输出速度", outputRate(s) === null ? "—" : `${Math.round(outputRate(s)!)} tok/s`);
    if (m.calls < s.steps || m.failed) {
      rows.push([]);
      if (m.calls < s.steps) note(`计时覆盖 ${m.calls}/${s.steps} 步`);
      if (m.failed) note(`已排除 ${m.failed} 次失败或取消`);
    }
    return { title: "会话统计", rows: spacedRows(rows) };
  }
  if (id === "tokens") {
    const total = exact(usageTotal(s));
    const headerTotal = visibleWidth("Token 用量") + visibleWidth(total) + 2 <= width - 5;
    if (!headerTotal) add("累计", total);
    add("缓存命中", percent(cacheHit(s)));
    add("未缓存输入", exact(s.usage.input));
    add("缓存读取", exact(s.usage.cacheRead));
    if (s.usage.cacheWrite) add("缓存写入", exact(s.usage.cacheWrite));
    add("输出", exact(s.usage.output));
    if (s.usage.cost) add("费用", `$${s.usage.cost.toFixed(4)}`);
    return { title: "Token 用量", ...(headerTotal ? { total } : {}), rows: spacedRows(rows) };
  }
  if (id === "context") {
    const c = s.context;
    add("上下文已用", percent(c?.percent));
    if (c?.tokens !== null && c?.tokens !== undefined) {
      const filled = Math.round(Math.min(1, Math.max(0, c.tokens / c.contextWindow)) * width);
      rows.push([span((config.icons === "ascii" ? "#" : "━").repeat(filled), "label"), span((config.icons === "ascii" ? "-" : "─").repeat(width - filled), "rule")], []);
      add("已用", exact(c.tokens));
      add("剩余", exact(Math.max(0, c.contextWindow - c.tokens)));
    } else note("待结算 · 等待下一次响应");
    if (c) add("容量", exact(c.contextWindow));
    return { title: "上下文", rows: spacedRows(rows) };
  }
  const reserved = new Set(config.more.sections.map(section => section.status));
  for (const section of config.more.sections.filter(section => !section.hidden)) {
    const text = cleanText(statuses.get(section.status) ?? "");
    add(section.label, text || "暂无状态");
  }
  if (config.more.includeUnmapped) {
    // 显式开启时仍不把实现 key 当成产品标题。
    const other = [...statuses].filter(([key]) => !reserved.has(key)).map(([, text]) => cleanText(text)).filter(Boolean);
    if (other.length) add("其他", other.join("\n"));
  }
  if (rows.length) rows.push([span((config.icons === "ascii" ? "-" : "─").repeat(width), "rule")]);
  if (s.working) add("运行", "进行中");
  add("模型", s.model);
  const provider = [s.provider, s.thinking].filter(Boolean).join(" · ");
  if (provider) add("提供方", provider);
  return { title: "更多", rows: spacedRows(rows) };
}
export const PANEL_PADDING = 3;
export const PANEL_HEADER_ROW = 2;
export const PANEL_CHROME_HEIGHT = 7;
export const PANEL_MIN_HEIGHT = PANEL_CHROME_HEIGHT + 1;
export const panelInnerWidth = (width: number) => Math.max(1, width - 2 - 2 * PANEL_PADDING);
export const panelCloseColumn = (width: number) => width - 3 - PANEL_PADDING;
export function panelLines(id: PanelId, s: Snapshot, config: FooterConfig, statuses: ReadonlyMap<string, string>, width: number, height: number, offset: number, theme: Theme): { lines: string[]; maxOffset: number } {
  if (width < 12 || height < PANEL_MIN_HEIGHT) return { lines: [], maxOffset: 0 };
  const inner = panelInnerWidth(width), content = panelContent(id, s, config, statuses, inner);
  const overflow = content.rows.length > height - PANEL_CHROME_HEIGHT;
  const bodyHeight = Math.max(0, height - PANEL_CHROME_HEIGHT - Number(overflow));
  const maxOffset = Math.max(0, content.rows.length - bodyHeight), start = Math.min(Math.max(0, offset), maxOffset);
  const ascii = config.icons === "ascii", horizontal = ascii ? "-" : "─", side = ascii ? "|" : "│";
  const light = theme.appearance === "light";
  const rgb = (r: number, g: number, b: number): Rgb => ({ kind: "rgb", r, g, b });
  const background = light ? rgb(246, 247, 249) : rgb(40, 42, 46);
  const edge = light ? rgb(211, 214, 220) : rgb(70, 73, 80);
  // 让宿主决定 truecolor/256 色编码；旧宿主回退终端底色，不回退彩色消息背景。
  const surface = (text: string) => theme.style ? theme.style(text, { bg: background }) : text;
  const borderPaint = (text: string) => theme.style && config.style.borderColor === "dim" ? theme.style(text, { fg: edge }) : theme.fg(config.style.borderColor, text);
  const paint = (part: Span) => part.tone === "rule" ? borderPaint(part.text) : theme.fg(part.tone === "value" ? "text" : part.tone === "note" ? "dim" : config.style.textColor, part.text);
  const body = (row: PanelRow) => surface(borderPaint(side) + " ".repeat(PANEL_PADDING) + row.map(paint).join("") + " ".repeat(Math.max(0, inner - visibleWidth(rowText(row))) + PANEL_PADDING) + borderPaint(side));
  const border = (left: string, right: string) => surface(borderPaint(left + horizontal.repeat(width - 2) + right));
  const headerWidth = Math.max(0, inner - 5);
  let title = fit(content.title, headerWidth);
  if (content.total) {
    if (visibleWidth(title) + visibleWidth(content.total) + 2 <= headerWidth) title += " ".repeat(headerWidth - visibleWidth(title) - visibleWidth(content.total)) + content.total;
    else title = fit(content.total, headerWidth);
  }
  const titleRow = inner < 5 ? [span(fit(content.title, inner), "value")] : [
    span(theme.bold ? theme.bold(title) : title, "value"),
    span(" ".repeat(Math.max(0, headerWidth - visibleWidth(title))) + "   ", "label"),
    span(theme.bold ? theme.bold("X") : "X", "value"), span(" ", "label"),
  ];
  const lines = [border(ascii ? "+" : "╭", ascii ? "+" : "╮"), body([]), body(titleRow), body([span(horizontal.repeat(inner), "rule")]), body([]), ...content.rows.slice(start, start + bodyHeight).map(body)];
  if (overflow) lines.push(body([span(fit(bodyHeight ? `${start + 1}–${Math.min(content.rows.length, start + bodyHeight)}/${content.rows.length} · 滚轮查看更多` : "终端高度不足", inner), "note")]));
  lines.push(body([]), border(ascii ? "+" : "╰", ascii ? "+" : "╯"));
  return { lines, maxOffset };
}
