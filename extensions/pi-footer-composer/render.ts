import { cacheHit, outputRate, usageTotal } from "./data.ts";
import { visibleWidth } from "./layout.ts";
import { cleanText, wrap } from "./wrapping.ts";
import type { FooterConfig, PanelId } from "./settings.ts";
import type { Snapshot } from "./types.ts";
export type Theme = { fg(color: string, text: string): string; bold?(text: string): string; bg?(color: string, text: string): string };
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
  const line = wrap(safe, width - 1)[0] ?? "";
  return `${line}…`;
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
  const moreLabel = config.icons === "ascii" ? "..." : "···";
  const gap = " ".repeat(config.style.gap);
  const parts = profiles.find(p => visibleWidth([...p, moreLabel].join(gap)) <= width) ?? [];
  const ids: PanelId[] = ["stats", "tokens", "context", "more"];
  const values = parts.length ? [...parts, moreLabel] : [width >= 3 ? moreLabel : ".".repeat(Math.max(0, width))];
  const hits: Hit[] = []; let x = 0;
  const painted = values.map((value, i) => {
    const id = parts.length ? ids[i] : "more", size = visibleWidth(value);
    hits.push({ id, x, width: size }); x += size + gap.length;
    const text = theme.fg(active === id ? "text" : config.style.textColor, value);
    return active === id && theme.bg ? theme.bg("customMessageBg", text) : text;
  });
  return { line: painted.join(gap), hits };
}
type Panel = { title: string; rows: string[] };
function pair(label: string, value: string, width: number): string[] {
  if (visibleWidth(label) + visibleWidth(value) + 2 <= width) return [label + " ".repeat(width - visibleWidth(label) - visibleWidth(value)) + value];
  return [...wrap(label, width), ...wrap(value, width)];
}
export function panelContent(id: PanelId, s: Snapshot, config: FooterConfig, statuses: ReadonlyMap<string, string>, width: number): Panel {
  const rows: string[] = [];
  const add = (label: string, value: string) => rows.push(...pair(label, value, width));
  const exact = (n: number) => `${Math.round(n).toLocaleString("en-US")} tok`;
  const m = s.metrics;
  if (id === "stats") {
    add("模型用时", m.calls > m.failed ? duration(m.llmMs) : "--");
    add("工具调用用时", m.tools > 0 ? duration(m.toolMs) : "--");
    add("首 token 平均（TTFT）", m.ttftCount ? duration(m.ttftMs / m.ttftCount) : "--");
    add("输出速度（TPS）", outputRate(s) === null ? "--" : `${Math.round(outputRate(s)!)} tok/s`);
    rows.push("", ...wrap("端到端 · 含等待与推理", width));
    if (m.calls < s.steps) rows.push(...wrap(`计时覆盖 ${m.calls}/${s.steps} 步；历史未计时步骤不参与速度与用时。`, width));
    if (m.failed) rows.push(...wrap(`${m.failed} 次失败或取消不参与速度、TTFT 和模型用时。`, width));
    rows.push(...wrap("工具用时累计；并行调用可重叠。", width));
    return { title: "会话统计", rows };
  }
  if (id === "tokens") {
    add("Token 用量", exact(usageTotal(s)));
    add("缓存命中", percent(cacheHit(s)));
    add("未缓存输入", exact(s.usage.input));
    add("缓存读取", exact(s.usage.cacheRead));
    if (s.usage.cacheWrite) add("缓存写入", exact(s.usage.cacheWrite));
    add("输出", exact(s.usage.output));
    if (s.usage.cost) add("费用", `$${s.usage.cost.toFixed(4)}`);
    rows.push("", ...wrap("当前分支累计（含摘要与额外用量）。\n输出含供应商计入的推理；缓存命中按输入加权。", width));
    return { title: "Token 用量", rows };
  }
  if (id === "context") {
    const c = s.context;
    add("上下文已用", percent(c?.percent));
    if (c?.tokens !== null && c?.tokens !== undefined) {
      add("用量 / 容量", `${exact(c.tokens)} / ${compactNumber(c.contextWindow)}`);
      const barWidth = Math.max(1, width), filled = Math.round(Math.min(1, Math.max(0, c.tokens / c.contextWindow)) * barWidth);
      rows.push(config.icons === "ascii" ? "#".repeat(filled) + "-".repeat(barWidth - filled) : "━".repeat(filled) + "─".repeat(barWidth - filled));
      add("剩余可用", exact(Math.max(0, c.contextWindow - c.tokens)));
    } else rows.push(...wrap("待结算：等待下一次响应更新上下文用量。", width));
    if (c) add("上下文容量", exact(c.contextWindow));
    rows.push("", ...wrap("宿主总量 · 不推算细分类别", width));
    return { title: "上下文", rows };
  }
  add("状态", s.working ? "运行中" : "就绪");
  add("模型", s.model);
  if (s.provider) add("提供方", s.provider);
  if (s.thinking) add("思考", s.thinking);
  const reserved = new Set(config.more.sections.map(section => section.status));
  const sections = config.more.sections.filter(section => !section.hidden).map(section => ({ label: section.label, text: cleanText(statuses.get(section.status) ?? "") }));
  if (config.more.includeUnmapped) {
    for (const [key, value] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
      if (!reserved.has(key)) sections.push({ label: cleanText(key), text: cleanText(value) });
    }
  }
  for (const section of sections) {
    rows.push("", ...wrap(section.label, width), ...wrap(section.text || "暂无状态", width));
  }
  if (!sections.length) rows.push("", ...wrap("尚未配置外部状态。可在 config.json 的 more.sections 中设置状态、诊断和额度的精确 key。", width));
  return { title: "更多", rows };
}
export function panelLines(id: PanelId, s: Snapshot, config: FooterConfig, statuses: ReadonlyMap<string, string>, width: number, height: number, offset: number, theme: Theme): { lines: string[]; maxOffset: number } {
  if (width < 6 || height < 4) return { lines: [], maxOffset: 0 };
  const inner = width - 4;
  const content = panelContent(id, s, config, statuses, inner);
  const bodyHeight = Math.max(1, height - 4);
  const maxOffset = Math.max(0, content.rows.length - bodyHeight), start = Math.min(Math.max(0, offset), maxOffset);
  const ascii = config.icons === "ascii", horizontal = ascii ? "-" : "─", side = ascii ? "|" : "│";
  const border = (left: string, right: string) => theme.fg(config.style.borderColor, left + horizontal.repeat(width - 2) + right);
  const body = (text: string, color = "muted") => theme.fg(config.style.borderColor, side) + " " + theme.fg(color, text + " ".repeat(Math.max(0, inner - visibleWidth(text)))) + " " + theme.fg(config.style.borderColor, side);
  const title = inner < 7 ? fit(content.title, inner) : fit(content.title, inner - 4) + " ".repeat(Math.max(1, inner - visibleWidth(fit(content.title, inner - 4)) - 3)) + "[x]";
  const shown = content.rows.slice(start, start + bodyHeight);
  const hint = maxOffset ? `${start + 1}–${Math.min(content.rows.length, start + bodyHeight)}/${content.rows.length} · 滚轮 · Esc 关闭` : "Esc 关闭";
  const lines = [border(ascii ? "+" : "╭", ascii ? "+" : "╮"), body(title, "text"), ...shown.map(line => body(line)), body(fit(hint, inner), "dim"), border(ascii ? "+" : "╰", ascii ? "+" : "╯")];
  return { lines: lines.map(line => theme.bg ? theme.bg("customMessageBg", line) : line), maxOffset };
}
