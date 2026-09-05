import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type FooterMode = "compact" | "full" | "native";

export interface FooterConfig {
  mode: FooterMode;
}

export interface FooterConfigStore {
  load(): FooterConfig;
  save(config: FooterConfig): void;
}

export const DEFAULT_FOOTER_CONFIG: Readonly<FooterConfig> = Object.freeze({
  mode: "compact",
});

function agentDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

export function footerConfigPath(agentDir = agentDirectory()): string {
  return join(agentDir, "extensions-data", "pi-footer-composer", "config.json");
}

function parseConfig(raw: string, path: string): FooterConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`配置不是有效 JSON：${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`配置必须是 JSON 对象：${path}`);
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "mode");
  if (unknown.length) throw new Error(`未知配置项：${unknown.join(", ")}`);
  const mode = record.mode ?? DEFAULT_FOOTER_CONFIG.mode;
  if (mode !== "compact" && mode !== "full" && mode !== "native") {
    throw new Error("mode 必须是 compact、full 或 native");
  }
  return { mode };
}

export function createFooterConfigStore(path = footerConfigPath()): FooterConfigStore {
  return {
    load(): FooterConfig {
      if (!existsSync(path)) return { ...DEFAULT_FOOTER_CONFIG };
      return parseConfig(readFileSync(path, "utf8"), path);
    },
    save(config: FooterConfig): void {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
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
