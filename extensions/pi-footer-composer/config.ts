import { cleanText } from "./wrapping.ts";
import { visibleWidth } from "./layout.ts";
import { BUILTIN_FIELDS, defaultFooterConfig, type FooterConfig, type StyleConfig, type ViewConfig } from "./settings.ts";
export { DEFAULT_FOOTER_CONFIG, defaultFooterConfig } from "./settings.ts";
export type { FooterConfig, FooterMode } from "./settings.ts";

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface FooterConfigStore { load(): FooterConfig; save(config: FooterConfig): void; }

function agentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export function footerConfigPath(agentDir = agentDirectory()): string {
  return join(agentDir, "extensions-data", "pi-footer-composer", "config.json");
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key}: 未知配置项`);
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || cleanText(value).replace(/\n/g, "") !== value.trim() || value.includes("\n")) {
    throw new Error(`${path} 必须是无终端控制符的单行文本`);
  }
}
function exactText(value: unknown, path: string): asserts value is string {
  text(value, path);
  if (value !== value.trim()) throw new Error(`${path} 首尾不能包含空格`);
}
function choice(value: unknown, values: readonly unknown[], path: string): void {
  if (!values.includes(value)) throw new Error(`${path} 必须是 ${values.join("、")}`);
}
function number(value: unknown, min: number, max: number, path: string, integer = true): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${path} 必须在 ${min}–${max} 之间${integer ? "且为整数" : ""}`);
  }
}
export function validSource(source: unknown): source is string {
  return typeof source === "string" && ((BUILTIN_FIELDS as readonly string[]).includes(source) || source === "remaining");
}
function applyStyle(target: StyleConfig, value: unknown, path: string): void {
  const style = object(value, path); keys(style, Object.keys(target), path);
  for (const [key, value] of Object.entries(style)) {
    const itemPath = `${path}.${key}`;
    if (key === "textColor" || key === "borderColor") choice(value, ["muted", "dim", "text"], itemPath);
    else if (key === "borders") choice(value, ["all", "outer", "none"], itemPath);
    else if (key === "overflow") choice(value, ["wrap", "ellipsis"], itemPath);
    else if (key === "labelDivider") { if (typeof value !== "boolean") throw new Error(`${itemPath} 必须是布尔值`); }
    else if (key === "leftRatio") number(value, 0.2, 0.8, itemPath, false);
    else if (key === "narrowWidth") number(value, 20, 300, itemPath);
    else if (key === "maxCellLines") number(value, 0, 100, itemPath);
    else number(value, 0, 16, itemPath);
  }
  Object.assign(target, style);
}
function view(value: unknown, path: string, fallback: ViewConfig, baseStyle: StyleConfig): ViewConfig {
  const obj = object(value, path); keys(obj, ["renderer", "showLabels", "style", "rows"], path);
  const result = structuredClone(fallback);
  if (obj.renderer !== undefined) { choice(obj.renderer, ["table", "bands"], `${path}.renderer`); result.renderer = obj.renderer as ViewConfig["renderer"]; }
  if (obj.showLabels !== undefined) {
    if (typeof obj.showLabels !== "boolean") throw new Error(`${path}.showLabels 必须是布尔值`);
    result.showLabels = obj.showLabels;
  }
  if (obj.style !== undefined) {
    const merged = { ...baseStyle, ...result.style };
    applyStyle(merged, obj.style, `${path}.style`);
    result.style = Object.fromEntries(Object.keys(object(obj.style, `${path}.style`)).map(key => [key, merged[key as keyof StyleConfig]])) as Partial<StyleConfig>;
  }
  if (obj.rows === undefined) return result;
  if (!Array.isArray(obj.rows)) throw new Error(`${path}.rows 必须是行数组`);
  obj.rows.forEach((row, i) => {
    const rowPath = `${path}.rows[${i}]`;
    if (!Array.isArray(row) || row.length < 1 || row.length > 2) throw new Error(`${rowPath} 必须包含 1 或 2 个单元格`);
    row.forEach((cell, j) => {
      if (cell === null) return;
      const cellPath = `${rowPath}[${j}]`;
      const c = object(cell, cellPath); keys(c, ["label", "fields", "hidden"], cellPath);
      exactText(c.label, `${cellPath}.label`);
      if (!c.label) throw new Error(`${cellPath}.label 不能为空`);
      if (visibleWidth(c.label) > 16) throw new Error(`${cellPath}.label 最多占 16 列`);
      if (c.hidden !== undefined && typeof c.hidden !== "boolean") throw new Error(`${cellPath}.hidden 必须是布尔值`);
      if (!Array.isArray(c.fields)) throw new Error(`${cellPath}.fields 必须是字段数组`);
      c.fields.forEach((field, k) => {
        const fieldPath = `${cellPath}.fields[${k}]`;
        if (typeof field === "string") {
          if (!validSource(field)) throw new Error(`${fieldPath}: 未知字段 ${field}`);
        } else {
          const f = object(field, fieldPath); keys(f, ["source", "status", "prefix", "suffix", "empty"], fieldPath);
          const hasSource = Object.hasOwn(f, "source");
          const hasStatus = Object.hasOwn(f, "status");
          if (hasSource === hasStatus) throw new Error(`${fieldPath} 必须且只能配置 source 或 status`);
          if (hasSource && !validSource(f.source)) throw new Error(`${fieldPath}.source: 未知字段 ${String(f.source)}`);
          if (hasStatus) {
            exactText(f.status, `${fieldPath}.status`);
            if (!f.status) throw new Error(`${fieldPath}.status 不能为空`);
          }
          for (const part of ["prefix", "suffix", "empty"]) if (f[part] !== undefined) text(f[part], `${fieldPath}.${part}`);
        }
      });
    });
  });
  result.rows = structuredClone(obj.rows) as ViewConfig["rows"];
  return result;
}
export function resolveFooterConfig(value: unknown): FooterConfig {
  const obj = object(value, "config");
  keys(obj, ["$schema", "mode", "style", "views"], "config");
  const result = defaultFooterConfig();
  if (obj.$schema !== undefined) { exactText(obj.$schema, "$schema"); result.$schema = obj.$schema; }
  if (obj.mode !== undefined) { choice(obj.mode, ["compact", "overview", "native"], "mode"); result.mode = obj.mode as FooterConfig["mode"]; }
  if (obj.style !== undefined) applyStyle(result.style, obj.style, "style");
  if (obj.views !== undefined) {
    const views = object(obj.views, "views"); keys(views, ["compact", "overview"], "views");
    for (const mode of ["compact", "overview"] as const) if (views[mode] !== undefined) result.views[mode] = view(views[mode], `views.${mode}`, result.views[mode], result.style);
  }
  return result;
}
function parseConfig(raw: string, path: string): FooterConfig {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`配置不是有效 JSON：${path}`); }
  return resolveFooterConfig(value);
}

export function createFooterConfigStore(
  path = footerConfigPath(),
): FooterConfigStore {
  return {
    load(): FooterConfig {
      if (!existsSync(path)) { const defaults = defaultFooterConfig(); this.save(defaults); return defaults; }
      return parseConfig(readFileSync(path, "utf8"), path);
    },
    save(config: FooterConfig): void {
      const valid = resolveFooterConfig(config);
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
