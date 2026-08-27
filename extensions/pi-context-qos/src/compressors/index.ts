import type { CompressionResult } from "./common.ts";
import { renderSummary } from "./common.ts";
import { compressBash } from "./bash.ts";
import { compressGit } from "./git.ts";
import { compressGrep } from "./grep.ts";
import { compressRead } from "./read.ts";
import { compressTests } from "./tests.ts";

function inputString(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? input[key] : "";
}

export function testIdentityFromInput(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName !== "bash" && toolName !== "powershell") return null;
  const command = inputString(input, "command").trim();
  const match = command.match(
    /(?:^|&&|;|\|\|)\s*((?:npm|pnpm|yarn)\s+(?:run\s+)?test\b[^;&|]*|pytest\b[^;&|]*|vitest\b[^;&|]*|jest\b[^;&|]*|mocha\b[^;&|]*|cargo\s+test\b[^;&|]*|go\s+test\b[^;&|]*)/i,
  );
  if (!match?.[1]) return null;
  return match[1].replace(/\s+/g, " ").trim().toLowerCase();
}

export function filePathFromInput(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!["read", "write", "edit"].includes(toolName)) return null;
  const path = inputString(input, "path") || inputString(input, "file_path");
  return path || null;
}

export function compressToolResult(
  toolName: string,
  input: Record<string, unknown>,
  text: string,
  isError: boolean,
): CompressionResult {
  const command = inputString(input, "command");
  if (testIdentityFromInput(toolName, input)) {
    return compressTests(text);
  }
  if (/\bgit\s+(?:status|diff|show|log)\b/i.test(command)) return compressGit(text);
  if (toolName === "read") return compressRead(text, filePathFromInput(toolName, input));
  if (["grep", "find", "ls"].includes(toolName)) return compressGrep(text);
  return compressBash(text, isError);
}

export { renderSummary };
