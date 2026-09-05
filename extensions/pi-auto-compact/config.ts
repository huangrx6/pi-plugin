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

export function agentDirectory(): string {
  const directory = process.env.PI_CODING_AGENT_DIR || "~/.pi/agent";
  return directory === "~" ? homedir() : directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : resolve(directory);
}

export function loadConfig(cwd: string, projectTrusted: boolean, agentDir = agentDirectory()): Config {
  const globalPath = join(agentDir, "extensions-data", "pi-auto-compact", "config.json");
  const projectPath = join(cwd, ".pi", "auto-compact.json");
  let config: Config = existsSync(globalPath)
    ? validate({ ...DEFAULT_CONFIG, ...read(globalPath) })
    : { ...DEFAULT_CONFIG };
  if (projectTrusted && existsSync(projectPath)) return validate({ ...config, ...read(projectPath) });
  return config;
}
