// Pure helpers shared by commands.js / lifecycle.js / index.js.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Locate the package root by walking up to find the `policies/manifest.json` +
 * `config/routing.json` pair. Falls back to `<startDir>/../..` when not found
 * (matches the package layout shipped in this repo).
 */
export function findPackageRoot(startDir) {
  let current = resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    if (
      existsSync(join(current, "policies", "manifest.json")) &&
      existsSync(join(current, "config", "routing.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, "..", "..");
}

export function cleanModel(model) {
  if (!model) return null;
  return {
    provider: model.provider ?? "unknown",
    id: model.id ?? model.name ?? "unknown",
  };
}

export function modelKey(model) {
  if (!model) return "unknown";
  return `${model.provider ?? "unknown"}/${model.id ?? model.name ?? "unknown"}`;
}

/**
 * Safe wrapper around ctx.ui.notify: silently no-op when running in a
 * non-interactive context that does not expose UI helpers (e.g. tests, RPC).
 */
export function notify(ctx, message, level = "info") {
  try {
    ctx?.ui?.notify?.(message, level);
  } catch {
    /* ignore */
  }
}

export function setStatus(ctx, text) {
  try {
    ctx?.ui?.setStatus?.("policy-engine", text);
  } catch {
    /* ignore */
  }
}

/**
 * Tokenize a `/policy <subcmd> [args...]` payload. Returns lowercase action
 * and remaining tokens.
 */
export function parsePolicyCommand(args) {
  const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  return { action: (parts[0] ?? "status").toLowerCase(), rest: parts.slice(1) };
}
