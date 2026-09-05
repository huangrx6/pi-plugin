import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatUsage, formatValidation } from "./format.ts";
import { validateTestSpecWithFixtures } from "./validator.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(ROOT, "schema/test-spec.schema.json");

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ""; }
    } else current += character;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("路径引号未闭合");
  if (current) tokens.push(current);
  return tokens;
}

export interface ParsedCommand {
  action: "validate" | "hash";
  specPath: string;
  registryPath?: string;
}

export function parseCommand(args: string): ParsedCommand | undefined {
  const tokens = tokenize(args);
  if (!tokens.length) return;
  const action = tokens.shift();
  if (action !== "validate" && action !== "hash") throw new Error("仅支持 validate 或 hash");
  const specPath = tokens.shift();
  if (!specPath) throw new Error("缺少 Test Spec 文件路径");
  let registryPath: string | undefined;
  while (tokens.length) {
    const flag = tokens.shift();
    if (flag !== "--registry") throw new Error(`未知参数：${flag}`);
    registryPath = tokens.shift();
    if (!registryPath) throw new Error("--registry 后缺少文件路径");
  }
  return { action, specPath, registryPath };
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function notify(ctx: any, message: string, level: "info" | "success" | "warning" = "info"): void {
  try { ctx.ui.notify(message, level); } catch { /* Terminal presentation is optional. */ }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("browser-test", {
    description: "校验 Test Spec v1.0 业务语义、Capability Contract 引用与稳定哈希。",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommand(String(args ?? ""));
        if (!parsed) { notify(ctx, formatUsage(SCHEMA_PATH)); return; }
        const cwd = ctx?.cwd ?? process.cwd();
        const specPath = resolve(cwd, parsed.specPath);
        const registryPath = resolve(cwd, parsed.registryPath ?? ".pi/browser-test/capability-registry.json");
        const [spec, registry] = await Promise.all([jsonFile(specPath), jsonFile(registryPath)]);
        const result = await validateTestSpecWithFixtures(spec, registry, dirname(specPath));
        if (parsed.action === "hash" && result.ok && result.hash) notify(ctx, result.hash, "success");
        else notify(ctx, formatValidation(result, specPath, registryPath), result.ok ? "success" : "warning");
      } catch (error) {
        notify(ctx, `Browser Test 未完成：${error instanceof Error ? error.message : String(error)}\n${formatUsage(SCHEMA_PATH)}`, "warning");
      }
    },
  });
}
