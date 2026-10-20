/**
 * 配置读取与校验 —— 尽力而为，绝不因坏配置打断会话。
 *
 * 路径：<agent-dir>/extensions-data/pi-throughput/config.json
 * <agent-dir> 跟随 PI_CODING_AGENT_DIR，默认 ~/.pi/agent。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MIN_WINDOW_MS, DEFAULT_THROTTLE_MS, PACKAGE_NAME } from "./constants.ts";
import type { DisplayMode, Measurement, ThroughputConfig } from "./types.ts";

export const DEFAULTS: ThroughputConfig = {
  enabled: true,
  display: "full",
  measurement: "stream",
  history: true,
  minWindowMs: DEFAULT_MIN_WINDOW_MS,
  throttleMs: DEFAULT_THROTTLE_MS,
};

/** 解析 <agent-dir>；空值或损坏的 PI_CODING_AGENT_DIR 退回默认目录。 */
export function agentDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(agentDir(env), "extensions-data", PACKAGE_NAME, "config.json");
}

function enumValue<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function booleanValue(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/** 把任意输入收窄成完整配置；未知 / 非法值退回默认，不抛异常。 */
export function normalizeConfig(raw: unknown): ThroughputConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: booleanValue(source.enabled, DEFAULTS.enabled),
    display: enumValue<DisplayMode>(source.display, ["full", "tps", "ttft"], DEFAULTS.display),
    measurement: enumValue<Measurement>(source.measurement, ["stream", "e2e"], DEFAULTS.measurement),
    history: booleanValue(source.history, DEFAULTS.history),
    minWindowMs: clampNumber(source.minWindowMs, DEFAULTS.minWindowMs, 100, 30_000),
    throttleMs: clampNumber(source.throttleMs, DEFAULTS.throttleMs, 0, 5_000),
  };
}

/** 读配置；文件缺失、损坏或不可读时返回默认值。 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ThroughputConfig {
  const path = configPath(env);
  try {
    if (!existsSync(path)) return { ...DEFAULTS };
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

/** 写配置；失败只静默放弃（显示偏好不值得打断会话）。 */
export function saveConfig(
  config: ThroughputConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const path = configPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    /* 尽力而为 */
  }
}
