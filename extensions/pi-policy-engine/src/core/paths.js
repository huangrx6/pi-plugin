import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Resolve on use: the agent directory can be configured before session startup.
export function agentDirectory() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  const expanded = configured === "~" || configured.startsWith("~/")
    ? homedir() + configured.slice(1)
    : configured;
  return resolve(expanded);
}

export function extensionDirectory() {
  return join(agentDirectory(), "extensions-data", "pi-policy-engine");
}

export function globalConfigPath() {
  const current = join(extensionDirectory(), "config.json");
  const legacy = join(agentDirectory(), "policy-engine.json");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function defaultHistoryFilePath() {
  const current = join(extensionDirectory(), "state");
  const legacy = join(agentDirectory(), "policy-engine");
  // Keep strict-plan files and history together, including when only plans exist.
  const directory = !existsSync(current) && existsSync(legacy) ? legacy : current;
  return join(directory, "history.jsonl");
}
