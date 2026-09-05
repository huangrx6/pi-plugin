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
  return join(extensionDirectory(), "config.json");
}

export function defaultHistoryFilePath() {
  return join(extensionDirectory(), "state", "history.jsonl");
}
