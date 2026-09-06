import { accessSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatBatch, formatRegistry, formatUsage, formatValidation } from "./format.ts";
import { parseCapabilityRegistry } from "./registry.ts";
import { validateTestSpecWithFixtures } from "./validator.ts";
import type { BatchEntryResult, ValidationIssue, ValidationResult } from "./types.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(ROOT, "schema/test-spec.schema.json");
const DEFAULT_REGISTRY_RELATIVE_PATH = join(CONFIG_DIR_NAME, "browser-test", "capability-registry.json");

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

export type ParsedCommand =
  | { action: "help" }
  | { action: "registry"; registryPath?: string }
  | { action: "validate" | "hash"; specPath: string; registryPath?: string };

export function parseCommand(args: string): ParsedCommand | undefined {
  const tokens = tokenize(args);
  if (!tokens.length) return;
  const action = tokens.shift()!;
  if (action === "help" || action === "--help" || action === "-h") return { action: "help" };
  if (action === "registry") {
    const registryPath = tokens.shift();
    if (registryPath?.startsWith("--")) throw new Error(`未知参数：${registryPath}`);
    if (tokens.length) throw new Error(`未知参数：${tokens[0]}`);
    return { action: "registry", registryPath };
  }
  if (action !== "validate" && action !== "hash") throw new Error("仅支持 validate、hash 或 registry");
  const specPath = tokens.shift();
  if (!specPath) throw new Error("缺少 Test Spec 文件路径");
  let registryPath: string | undefined;
  while (tokens.length) {
    const flag = tokens.shift()!;
    if (flag === "--registry") {
      registryPath = tokens.shift();
      if (!registryPath) throw new Error("--registry 后缺少文件路径");
    } else if (flag.startsWith("--registry=")) {
      registryPath = flag.slice("--registry=".length);
      if (!registryPath) throw new Error("--registry 后缺少文件路径");
    } else throw new Error(`未知参数：${flag}`);
  }
  return { action, specPath, registryPath };
}

export class MissingJsonFileError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export async function loadJsonFile(path: string, role: string, missingHint?: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new MissingJsonFileError(`${role}文件不存在：${path}`, missingHint);
    if (code === "EISDIR") throw new MissingJsonFileError(`${role}路径是一个目录：${path}`, missingHint);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${role}不是合法 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

export function findDefaultRegistry(startDir: string): string {
  const fallback = join(resolve(startDir), DEFAULT_REGISTRY_RELATIVE_PATH);
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, DEFAULT_REGISTRY_RELATIVE_PATH);
    try { accessSync(candidate); return candidate; } catch { /* keep walking up. */ }
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

type NotifyLevel = "info" | "warning" | "error";

export function notify(ctx: ExtensionContext | undefined, message: string, level: NotifyLevel = "info"): void {
  if (ctx?.hasUI === false || typeof ctx?.ui?.notify !== "function") { console.log(message); return; }
  try { ctx.ui.notify(message, level); } catch { console.log(message); }
}

async function validateBatch(action: "validate" | "hash", dirPath: string, registryInput: unknown): Promise<BatchEntryResult[]> {
  const entries = (await readdir(dirPath)).filter((name) => name.endsWith(".test-spec.json")).sort();
  if (!entries.length) throw new Error(`目录中没有 .test-spec.json 文件：${dirPath}`);
  return Promise.all(entries.map(async (name): Promise<BatchEntryResult> => {
    const filePath = join(dirPath, name);
    try {
      const spec = await loadJsonFile(filePath, "Test Spec ");
      return { file: filePath, result: await validateTestSpecWithFixtures(spec, registryInput, dirname(filePath)) };
    } catch (error) {
      return { file: filePath, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

export interface ValidationRunResult {
  ok: boolean;
  message: string;
  issues: ValidationIssue[];
  hash?: string;
  files?: Array<{ file: string; ok: boolean; hash?: string; error?: string; issues: ValidationIssue[] }>;
}

export async function runValidation(action: "validate" | "hash", cwd: string, specArg: string, registryArg?: string): Promise<ValidationRunResult> {
  const specPath = resolve(cwd, specArg);
  const registryPath = registryArg ? resolve(cwd, registryArg) : findDefaultRegistry(cwd);
  const registryHint = registryArg
    ? undefined
    : `未在 ${cwd} 及其上级目录找到 ${DEFAULT_REGISTRY_RELATIVE_PATH}，可用 --registry <path> 显式指定 Capability Registry。`;
  const isDirectory = await stat(specPath).then((stats) => stats.isDirectory()).catch(() => false);
  if (isDirectory) {
    const registry = await loadJsonFile(registryPath, "Capability Registry ", registryHint);
    const entries = await validateBatch(action, specPath, registry);
    const files = entries.map((entry) => ({
      file: entry.file,
      ok: !!entry.result?.ok,
      hash: entry.result?.hash,
      error: entry.error,
      issues: entry.result ? [...entry.result.schemaIssues, ...entry.result.semanticIssues] : [],
    }));
    return { ok: files.every((file) => file.ok), message: formatBatch(action, specPath, registryPath, entries), issues: [], files };
  }
  const [spec, registry] = await Promise.all([
    loadJsonFile(specPath, "Test Spec "),
    loadJsonFile(registryPath, "Capability Registry ", registryHint),
  ]);
  const result: ValidationResult = await validateTestSpecWithFixtures(spec, registry, dirname(specPath));
  const issues: ValidationIssue[] = [...result.schemaIssues, ...result.semanticIssues];
  if (action === "hash" && result.ok && result.hash) return { ok: true, message: result.hash, issues, hash: result.hash };
  return { ok: result.ok, message: formatValidation(result, specPath, registryPath), issues, ...(result.hash ? { hash: result.hash } : {}) };
}

function validationErrorMessage(error: unknown): string {
  const lines = [`Browser Test 未完成：${error instanceof Error ? error.message : String(error)}`];
  if (error instanceof MissingJsonFileError && error.hint) lines.push(error.hint);
  return lines.join("\n");
}

const TOOL_NAME = "browser_test";

const VALIDATE_TOOL_PARAMS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Test Spec JSON file, or a directory whose direct children *.test-spec.json are validated as a batch" },
    registry: { type: "string", description: "Optional Capability Registry JSON path; defaults to .pi/browser-test/capability-registry.json searched upward from the working directory" },
  },
  required: ["path"],
  additionalProperties: false,
};

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("browser-test", {
    description: "校验 Test Spec v1.0 业务语义、Capability Contract 引用与稳定哈希，支持单文件或目录批量。",
    handler: async (args, ctx) => {
      try {
        const parsed = parseCommand(String(args ?? ""));
        if (!parsed || parsed.action === "help") { notify(ctx, formatUsage(SCHEMA_PATH, DEFAULT_REGISTRY_RELATIVE_PATH)); return; }
        const cwd = ctx?.cwd ?? process.cwd();
        if (parsed.action === "registry") {
          const registryPath = parsed.registryPath ? resolve(cwd, parsed.registryPath) : findDefaultRegistry(cwd);
          const registry = await loadJsonFile(
            registryPath,
            "Capability Registry ",
            parsed.registryPath ? undefined : `未在 ${cwd} 及其上级目录找到 ${DEFAULT_REGISTRY_RELATIVE_PATH}，可显式给出注册表路径。`,
          );
          const issues = parseCapabilityRegistry(registry).issues;
          notify(ctx, formatRegistry(registryPath, issues), issues.length ? "warning" : "info");
          return;
        }
        const run = await runValidation(parsed.action, cwd, parsed.specPath, parsed.registryPath);
        notify(ctx, run.message, run.ok ? "info" : "warning");
      } catch (error) {
        notify(ctx, `${validationErrorMessage(error)}\n${formatUsage(SCHEMA_PATH, DEFAULT_REGISTRY_RELATIVE_PATH)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Browser Test",
    description: "Validate business-level browser Test Spec v1.0 files (or a directory of *.test-spec.json as a batch) against the frozen schema, semantic rules TS-001..TS-015, fixture integrity and a Capability Registry. Returns stable error codes with JSON Pointer paths, or the TestSpecHash when valid.",
    promptSnippet: "Validate Test Spec v1.0 files or directories against Capability Contracts",
    promptGuidelines: [
      "Use browser_test after creating or editing any *.test-spec.json file, and iterate on the reported TS-XXX codes until validation passes before claiming the test spec is ready.",
    ],
    parameters: VALIDATE_TOOL_PARAMS,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const specArg = String(params?.path ?? "").trim();
      if (!specArg) {
        return { content: [{ type: "text", text: "path is required: a Test Spec JSON file or a directory of *.test-spec.json files." }], details: { ok: false } };
      }
      try {
        const cwd = ctx?.cwd ?? process.cwd();
        const run = await runValidation("validate", cwd, specArg, params?.registry ? String(params.registry) : undefined);
        return {
          content: [{ type: "text", text: run.message }],
          details: {
            ok: run.ok,
            ...(run.hash ? { hash: run.hash } : {}),
            ...(run.files ? { files: run.files } : { issues: run.issues }),
          },
        };
      } catch (error) {
        return { content: [{ type: "text", text: validationErrorMessage(error) }], details: { ok: false } };
      }
    },
  });
}
