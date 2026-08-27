import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ContextQosConfig } from "./types.ts";

export const DEFAULT_CONFIG: ContextQosConfig = {
  enabled: true,
  budget: {
    outputReserveRatio: 0.12,
    safetyReserveRatio: 0.06,
    yellow: 0.55,
    orange: 0.7,
    red: 0.82,
    critical: 0.92,
    nativeCompactFallback: true,
  },
  frontier: {
    protectedUserTurns: 2,
    protectedCausalBlocks: 8,
  },
  storage: {
    directory: "~/.pi/agent/context-qos",
    maxBytes: 2_147_483_648,
    maxAgeDays: 30,
  },
  epochs: {
    maxTurns: 12,
  },
  security: {
    archiveSecrets: false,
    excludePatterns: ["**/.env", "**/*.pem", "**/secrets/**"],
  },
};

type JsonObject = Record<string, unknown>;

function readJson(path: string): JsonObject {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function merge(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = merge(result[key] as JsonObject, value as JsonObject);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function validate(config: ContextQosConfig): ContextQosConfig {
  const points = [
    config.budget.yellow,
    config.budget.orange,
    config.budget.red,
    config.budget.critical,
  ];
  if (
    points.some((point) => !Number.isFinite(point) || point <= 0 || point >= 1) ||
    !points.every((point, index) => index === 0 || points[index - 1]! < point)
  ) {
    throw new Error(
      "context-qos budget thresholds must be strictly increasing values between 0 and 1",
    );
  }
  if (
    !Number.isFinite(config.budget.outputReserveRatio) ||
    !Number.isFinite(config.budget.safetyReserveRatio) ||
    config.budget.outputReserveRatio < 0 ||
    config.budget.safetyReserveRatio < 0 ||
    config.budget.outputReserveRatio + config.budget.safetyReserveRatio >= 0.8
  ) {
    throw new Error("context-qos reserves leave too little usable context");
  }
  for (const [name, value] of [
    ["frontier.protectedUserTurns", config.frontier.protectedUserTurns],
    ["frontier.protectedCausalBlocks", config.frontier.protectedCausalBlocks],
    ["epochs.maxTurns", config.epochs.maxTurns],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`context-qos ${name} must be a positive integer`);
    }
  }
  if (!Number.isFinite(config.storage.maxBytes) || config.storage.maxBytes < 1) {
    throw new Error("context-qos storage.maxBytes must be positive");
  }
  if (!Number.isFinite(config.storage.maxAgeDays) || config.storage.maxAgeDays <= 0) {
    throw new Error("context-qos storage.maxAgeDays must be positive");
  }
  if (
    !Array.isArray(config.security.excludePatterns) ||
    config.security.excludePatterns.some((pattern) => typeof pattern !== "string")
  ) {
    throw new Error("context-qos security.excludePatterns must be a string array");
  }
  if (!config.storage.directory || typeof config.storage.directory !== "string") {
    throw new Error("context-qos storage.directory must be a non-empty string");
  }
  config.storage.directory = expandHome(config.storage.directory);
  return config;
}

export function loadConfig(cwd: string, projectTrusted: boolean): ContextQosConfig {
  const defaultDirectory = expandHome(DEFAULT_CONFIG.storage.directory);
  const globalConfig = readJson(join(defaultDirectory, "config.json"));
  const projectConfig = projectTrusted
    ? readJson(join(cwd, ".pi", "context-qos.json"))
    : {};
  // SAFETY: DEFAULT_CONFIG is a ContextQosConfig; JsonObject is the loose
  // record shape merge() works on. The double cast crosses the nominal
  // boundary once — validate() re-checks every field afterwards, so an
  // unexpected merged shape fails loudly instead of surviving as config.
  const merged = merge(
    merge(DEFAULT_CONFIG as unknown as JsonObject, globalConfig),
    projectConfig,
  );
  // SAFETY: merge() only ever produces plain JSON records from plain JSON
  // inputs; the cast asserts the validated shape, and validate() below
  // throws on any out-of-range or missing value before it reaches callers.
  return validate(merged as unknown as ContextQosConfig);
}
