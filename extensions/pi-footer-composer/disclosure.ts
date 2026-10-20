/** 单行折叠入口；详情仍由配置视图渲染。 */
import type { Snapshot } from "./data.ts";
import { visibleWidth } from "./layout.ts";
import { cleanText, wrap } from "./wrapping.ts";

export function disclosureText(snapshot: Snapshot, collapsed: boolean, requestedWidth: number, clickable = true): string {
  const width = Number.isFinite(requestedWidth) ? Math.max(0, Math.floor(requestedWidth)) : 0;
  if (!width) return "";
  const parts = collapsed
    ? [clickable ? "▸ 详情（点击展开）" : "▸ 详情（/footer toggle）", snapshot.fields.project, snapshot.fields.model, `ctx: ${snapshot.fields.context}`]
    : [clickable ? "▾ 收起详情" : "▾ 收起详情（/footer toggle）"];
  const text = parts.filter(Boolean).map(part => cleanText(part).replace(/\n/g, " ")).join(" · ");
  if (visibleWidth(text) <= width) return text;
  return width === 1 ? "…" : `${wrap(text, width - 1)[0] || ""}…`;
}

export type FooterMouseEvent = {
  type: string; button: string; x: number; y: number; width: number;
  shift?: boolean; alt?: boolean; ctrl?: boolean; clickCount?: number;
};

/** 只响应标题行的普通左键单击，详情区、滚动与选择不触发折叠。 */
export function isDisclosureClick(event: FooterMouseEvent): boolean {
  return event.type === "click" && event.button === "left" && event.y === 0 &&
    event.x >= 0 && event.x < event.width && !event.shift && !event.alt && !event.ctrl &&
    (event.clickCount === undefined || event.clickCount === 1);
}
