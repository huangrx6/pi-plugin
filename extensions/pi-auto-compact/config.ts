import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config { enabled: boolean; thresholdPercent: number }
export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({ enabled: true, thresholdPercent: 60 });
type Json = Record<string, unknown>;

function read(path: string): Json {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`配置必须是 JSON 对象：${path}`);
  return value as Json;
}

function validate(value: Json): Config {
  if (typeof value.enabled !== "boolean") throw new Error("enabled 必须为 true 或 false");
  const percent = value.thresholdPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    throw new Error("thresholdPercent 必须大于 0 且小于 100");
  }
  return { enabled: value.enabled, thresholdPercent: percent };
}

/** The old percentage used the usable budget; preserve its full-window trigger. */
export function translateLegacy(value: Json): Config {
  const budget = "budget" in value ? value.budget : {};
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new Error("旧配置 budget 必须是对象");
  const b = budget as Json;
  const critical = "critical" in b ? b.critical : 0.92;
  const output = "outputReserveRatio" in b ? b.outputReserveRatio : 0.12;
  const safety = "safetyReserveRatio" in b ? b.safetyReserveRatio : 0.06;
  if ([critical, output, safety].some(n => typeof n !== "number" || !Number.isFinite(n)) ||
      Number(critical) <= 0 || Number(critical) >= 1 || Number(output) < 0 || Number(safety) < 0 || Number(output) + Number(safety) >= 0.8) {
    throw new Error("旧配置的压缩阈值或预留比例无效");
  }
  if (b.nativeCompactFallback !== undefined && typeof b.nativeCompactFallback !== "boolean") throw new Error("旧配置 nativeCompactFallback 必须为布尔值");
  const enabled = "enabled" in value ? value.enabled : true;
  if (typeof enabled !== "boolean") throw new Error("旧配置 enabled 必须为布尔值");
  return validate({ enabled: enabled && b.nativeCompactFallback !== false,
    thresholdPercent: Number((Number(critical) * (1 - Number(output) - Number(safety)) * 100).toFixed(8)) });
}

export function agentDirectory(): string {
  const directory = process.env.PI_CODING_AGENT_DIR || "~/.pi/agent";
  return directory === "~" ? homedir() : directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : resolve(directory);
}

export function loadConfig(cwd: string, projectTrusted: boolean, agentDir = agentDirectory()): Config {
  const globalPath = join(agentDir, "extensions-data", "pi-auto-compact", "config.json");
  const projectPath = join(cwd, ".pi", "auto-compact.json");
  const oldGlobal = [join(agentDir, "extensions-data", "pi-context-qos", "config.json"), join(agentDir, "context-qos", "config.json")].find(existsSync);
  const oldProject = projectTrusted ? join(cwd, ".pi", "context-qos.json") : undefined;
  const legacyGlobal = !existsSync(globalPath) && oldGlobal ? read(oldGlobal) : undefined;
  let config: Config = existsSync(globalPath)
    ? validate({ ...DEFAULT_CONFIG, ...read(globalPath) })
    : legacyGlobal ? translateLegacy(legacyGlobal) : { ...DEFAULT_CONFIG };
  if (projectTrusted && existsSync(projectPath)) return validate({ ...config, ...read(projectPath) });
  if (oldProject && existsSync(oldProject)) {
    const project = read(oldProject);
    if (project.budget !== undefined && (!project.budget || typeof project.budget !== "object" || Array.isArray(project.budget))) throw new Error("旧配置 budget 必须是对象");
    const budget = project.budget as Json | undefined;
    const changesBehavior = "enabled" in project || (budget && ["critical", "outputReserveRatio", "safetyReserveRatio", "nativeCompactFallback"].some(key => key in budget));
    if (existsSync(globalPath) && changesBehavior) throw new Error("请将项目 .pi/context-qos.json 转换为 .pi/auto-compact.json：全局配置已迁移，旧项目阈值所依赖的预留比例无法可靠还原");
    const translated = translateLegacy({ ...legacyGlobal, ...project,
      budget: { ...(legacyGlobal?.budget as Json ?? {}), ...(budget ?? {}) } });
    // A legacy project that only sets archival options has no new override.
    const hasThreshold = budget && ["critical", "outputReserveRatio", "safetyReserveRatio"].some(key => key in budget);
    const hasEnabled = "enabled" in project || (budget && "nativeCompactFallback" in budget);
    config = { enabled: hasEnabled ? translated.enabled : config.enabled,
      thresholdPercent: hasThreshold ? translated.thresholdPercent : config.thresholdPercent };
  }
  return config;
}
