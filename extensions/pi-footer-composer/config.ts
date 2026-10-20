import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { visibleWidth } from "./layout.ts";
import { cleanText } from "./wrapping.ts";
import { defaultFooterConfig, type FooterConfig } from "./settings.ts";
export { defaultFooterConfig } from "./settings.ts";
export type { FooterConfig, FooterMode } from "./settings.ts";
export interface FooterConfigStore { load(): FooterConfig; save(config: FooterConfig): void }
function agentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  return configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : resolve(configured);
}
export function footerConfigPath(agentDir = agentDirectory()): string {
  return join(agentDir, "extensions-data", "pi-footer-composer", "config.json");
}
function object(value: unknown, path: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是 JSON 对象`);
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key}: 未知配置项`);
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value || value !== cleanText(value) || value.includes("\n")) throw new Error(`${path} 必须是无控制符、无首尾空格的非空单行文本`);
}
function choice(value: unknown, allowed: unknown[], path: string): void {
  if (!allowed.includes(value)) throw new Error(`${path} 必须是 ${allowed.join("、")}`);
}
export function resolveFooterConfig(value: unknown): FooterConfig {
  const obj = object(value, "config"), result = defaultFooterConfig();
  keys(obj, ["$schema", "version", "mode", "icons", "style", "more"], "config");
  if (obj.$schema !== undefined) { text(obj.$schema, "$schema"); result.$schema = obj.$schema; }
  if (obj.version !== undefined) choice(obj.version, [5], "version");
  if (obj.mode !== undefined) { choice(obj.mode, ["custom", "native"], "mode"); result.mode = obj.mode; }
  if (obj.icons !== undefined) { choice(obj.icons, ["unicode", "ascii"], "icons"); result.icons = obj.icons; }
  if (obj.style !== undefined) {
    const style = object(obj.style, "style"); keys(style, Object.keys(result.style), "style");
    for (const [key, value] of Object.entries(style)) {
      if (key === "textColor" || key === "borderColor") choice(value, ["muted", "dim", "text"], `style.${key}`);
      else {
        const [min, max] = key === "gap" ? [1, 8] : [28, 100];
        if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`style.${key} 必须是 ${min}–${max} 的整数`);
      }
    }
    Object.assign(result.style, style);
  }
  if (obj.more !== undefined) {
    const more = object(obj.more, "more"); keys(more, ["sections", "includeUnmapped"], "more");
    if (more.includeUnmapped !== undefined) {
      if (typeof more.includeUnmapped !== "boolean") throw new Error("more.includeUnmapped 必须是布尔值");
      result.more.includeUnmapped = more.includeUnmapped;
    }
    if (more.sections !== undefined) {
      if (!Array.isArray(more.sections)) throw new Error("more.sections 必须是数组");
      const seen = new Set<string>();
      result.more.sections = more.sections.map((value: unknown, i: number) => {
        const section = object(value, `more.sections[${i}]`); keys(section, ["label", "status", "hidden"], `more.sections[${i}]`);
        text(section.label, `more.sections[${i}].label`); text(section.status, `more.sections[${i}].status`);
        if (section.hidden !== undefined && typeof section.hidden !== "boolean") throw new Error(`more.sections[${i}].hidden 必须是布尔值`);
        if (seen.has(section.status)) throw new Error(`重复 status: ${section.status}`);
        seen.add(section.status);
        return { ...section } as FooterConfig["more"]["sections"][number];
      });
    }
  }
  return result;
}
function validateLegacy(obj: Record<string, any>): void {
  const bool = (value: unknown, path: string) => { if (value !== undefined && typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`); };
  const style = (value: unknown) => {
    if (value === undefined) return;
    const item = object(value, "旧配置.style");
    const ranges: Record<string, number[]> = { labelWidth: [0, 16], columnGap: [0, 16], fieldGap: [0, 16], leftRatio: [0.2, 0.8], narrowWidth: [20, 300], maxCellLines: [0, 100] };
    keys(item, ["textColor", "borderColor", "borders", "labelDivider", "overflow", ...Object.keys(ranges)], "旧配置.style");
    for (const [key, value] of Object.entries(item)) {
      if (key === "textColor" || key === "borderColor") choice(value, ["muted", "dim", "text"], key);
      else if (key === "borders") choice(value, ["all", "outer", "none"], key);
      else if (key === "overflow") choice(value, ["wrap", "ellipsis"], key);
      else if (key === "labelDivider") bool(value, key);
      else if (typeof value !== "number" || !Number.isFinite(value) || value < ranges[key][0] || value > ranges[key][1] || key !== "leftRatio" && !Number.isInteger(value)) throw new Error(`旧配置.style.${key} 无效`);
    }
  };
  bool(obj.collapsed, "旧配置.collapsed"); style(obj.style);
  if (obj.$schema !== undefined) text(obj.$schema, "$schema");
  if (obj.views === undefined) return;
  const views = object(obj.views, "旧配置.views"); keys(views, ["compact", "overview"], "旧配置.views");
  const sources = ["project", "cwd", "branch", "session", "model", "provider", "thinking", "context", "cacheHit", "input", "output", "cacheRead", "cacheWrite", "cost", "remaining"];
  for (const value of Object.values(views)) {
    const view = object(value, "旧配置.view"); keys(view, ["renderer", "showLabels", "style", "rows"], "旧配置.view");
    if (view.renderer !== undefined) choice(view.renderer, ["table", "bands"], "旧配置.renderer");
    bool(view.showLabels, "旧配置.showLabels"); style(view.style);
    if (view.rows === undefined) continue;
    if (!Array.isArray(view.rows)) throw new Error("旧配置.rows 必须是数组");
    for (const row of view.rows) {
      if (!Array.isArray(row) || row.length < 1 || row.length > 2) throw new Error("旧配置.row 必须包含 1 或 2 个单元格");
      for (const value of row) {
        if (value === null) continue;
        const cell = object(value, "旧配置.cell"); keys(cell, ["label", "fields", "hidden"], "旧配置.cell");
        text(cell.label, "旧配置.label"); if (visibleWidth(cell.label) > 16) throw new Error("旧配置.label 最多占 16 列");
        bool(cell.hidden, "旧配置.hidden");
        if (!Array.isArray(cell.fields)) throw new Error("旧配置.fields 必须是数组");
        for (const value of cell.fields) {
          if (typeof value === "string") { choice(value, sources, "旧配置.source"); continue; }
          const field = object(value, "旧配置.field"); keys(field, ["source", "status", "prefix", "suffix", "empty"], "旧配置.field");
          if (Object.hasOwn(field, "source") === Object.hasOwn(field, "status")) throw new Error("旧配置.field 必须且只能有 source 或 status");
          if (Object.hasOwn(field, "source")) choice(field.source, sources, "旧配置.source"); else text(field.status, "旧配置.status");
          for (const part of ["prefix", "suffix", "empty"]) if (field[part] !== undefined && (typeof field[part] !== "string" || field[part].includes("\n") || cleanText(field[part]) !== field[part].trim())) throw new Error(`旧配置.${part} 文本无效`);
        }
      }
    }
  }
}
/** 只迁移精确 status 选择器；不解析发布者文本，不猜测 key 的含义。 */
export function migrateLegacyConfig(value: unknown): FooterConfig {
  const obj = object(value, "旧配置");
  keys(obj, ["$schema", "mode", "collapsed", "style", "views"], "旧配置");
  if (obj.mode !== undefined) choice(obj.mode, ["compact", "overview", "native"], "旧配置.mode");
  validateLegacy(obj);
  const next = defaultFooterConfig();
  if (obj.style?.textColor) next.style.textColor = obj.style.textColor;
  if (obj.style?.borderColor) next.style.borderColor = obj.style.borderColor;
  next.mode = obj.mode === "native" ? "native" : "custom";
  const views = obj.views === undefined ? {} : object(obj.views, "旧配置.views");
  const view = views[obj.mode === "overview" ? "overview" : "compact"] ?? views.compact ?? views.overview;
  if (view !== undefined) {
    const rows = object(view, "旧配置.view").rows ?? [];
    if (!Array.isArray(rows)) throw new Error("旧配置.rows 必须是数组");
    const seen = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row)) throw new Error("旧配置.row 必须是数组");
      for (const cell of row) {
        if (cell === null) continue;
        const item = object(cell, "旧配置.cell"); text(item.label, "旧配置.label");
        if (!Array.isArray(item.fields)) throw new Error("旧配置.fields 必须是数组");
        for (const field of item.fields) {
          if (!item.hidden && !["项目", "策略", "速度"].includes(item.label) && (field === "remaining" || field?.source === "remaining")) next.more.includeUnmapped = true;
          if (typeof field !== "object" || !field || !Object.hasOwn(field, "status")) continue;
          text(field.status, "旧配置.status");
          if (seen.has(field.status)) continue;
          seen.add(field.status);
          next.more.sections.push({ label: item.label, status: field.status,
            ...((item.hidden || ["项目", "策略", "速度"].includes(item.label)) ? { hidden: true } : {}) });
        }
      }
    }
  }
  return resolveFooterConfig(next);
}
export function createFooterConfigStore(path = footerConfigPath()): FooterConfigStore {
  return {
    load() {
      if (!existsSync(path)) { const result = defaultFooterConfig(); this.save(result); return result; }
      const raw = readFileSync(path, "utf8");
      let value: any;
      try { value = JSON.parse(raw); } catch { throw new Error(`配置不是有效 JSON：${path}`); }
      if (value && value.version === undefined && (value.views !== undefined || value.collapsed !== undefined || ["compact", "overview"].includes(value.mode))) {
        const next = migrateLegacyConfig(value);
        const backup = join(dirname(dirname(path)), ".backups", "pi-footer-composer", `config-v4-${randomUUID()}.json`);
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        writeFileSync(backup, raw, { mode: 0o600, flag: "wx" });
        this.save(next);
        return next;
      }
      return resolveFooterConfig(value);
    },
    save(config) {
      const next = resolveFooterConfig(config);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    },
  };
}
