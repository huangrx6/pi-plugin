#!/usr/bin/env node
// check-config.js — 用户配置 reload 前自查（manual-only）
//
// 行为：
//   1. 扫描仓库根 extensions/*/config/defaults.json 或
//      schema/config.schema.json，提取已知合法顶层 key 集合（每个扩展独立）。
//   2. 读取 PI_CODING_AGENT_DIR（或 ~/.pi/agent）下的 extensions-data/<pkg>/config.json。
//   3. 对每个文件：
//      - JSON 解析失败 → error（用户配置坏了，重启必出问题）
//      - 顶层 key 不在扩展配置定义中 → warning（"unknown setting" 类诊断）
//      - value 类型与配置定义不匹配 → warning
//   4. 退出码：0 = 无 error；1 = 至少一个 error。warning 不影响退出码。
//
// 设计原则：
//   - 零依赖（纯 Node.js + 已有的 package.json 读取）
//   - 不修改任何文件
//   - 保守判断：宁可放过可疑项，不误报
//   - 输出人类可读文本（不用 JSON schema 验证器，避免引入 ajv 等）
//
// 用法：
//   node scripts/check-config.js
//   或：npm run config:validate

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const extensionsDir = join(repoRoot, "extensions");

function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  return configured.startsWith("~/")
    ? join(homedir(), configured.slice(2))
    : configured;
}

/** 从 defaults 或公开 Schema 收集合法顶层 key 与类型。 */
function loadDefaults(pkg) {
  const path = join(extensionsDir, pkg, "config", "defaults.json");
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
        const types = {};
        for (const [k, v] of Object.entries(cfg)) {
          types[k] = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        }
        return types;
      }
    } catch {
      /* ignore — defaults.json 损坏，不影响其他扩展的用户配置校验 */
    }
  }

  const schemaPath = join(extensionsDir, pkg, "schema", "config.schema.json");
  if (!existsSync(schemaPath)) return null;
  try {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    if (!schema?.properties || typeof schema.properties !== "object") return null;
    const types = {};
    for (const [key, definition] of Object.entries(schema.properties)) {
      const declared = definition?.type;
      // enum-only properties in JSON Schema are strings in current configs.
      types[key] = typeof declared === "string" ? declared : Array.isArray(definition?.enum) ? "string" : null;
    }
    return types;
  } catch {
    /* ignore — schema 损坏应由扩展自己的 check/test 报告 */
  }
  return null;
}

/** 读取用户 config.json；文件不存在时返回 null（视为该扩展未配置）。 */
function readUserConfig(pkg, dir) {
  const path = join(dir, "extensions-data", pkg, "config.json");
  if (!existsSync(path)) return { exists: false, path };
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    return { exists: true, path, config: parsed, raw: text };
  } catch (err) {
    return { exists: true, path, parseError: err.message };
  }
}

const warnings = [];
const errors = [];

function warn(pkg, msg) {
  warnings.push(`[warn] ${pkg}: ${msg}`);
}
function error(pkg, msg) {
  errors.push(`[error] ${pkg}: ${msg}`);
}

const pkgDirs = existsSync(extensionsDir)
  ? readdirSync(extensionsDir).filter((d) => {
      try {
        return statSync(join(extensionsDir, d)).isDirectory();
      } catch {
        return false;
      }
    })
  : [];

const dir = agentDir();

console.log(`PI_CODING_AGENT_DIR = ${dir}\n`);

for (const pkg of pkgDirs.sort()) {
  const defaults = loadDefaults(pkg);
  if (!defaults) continue; // 扩展没有可读取的配置定义，跳过

  const user = readUserConfig(pkg, dir);
  if (!user.exists) continue; // 用户未配置，不检查

  if (user.parseError) {
    error(pkg, `config.json JSON 解析失败：${user.parseError}（${user.path}）`);
    continue;
  }

  if (
    !user.config ||
    typeof user.config !== "object" ||
    Array.isArray(user.config)
  ) {
    error(pkg, `config.json 顶层必须是 JSON 对象（${user.path}）`);
    continue;
  }

  for (const [key, value] of Object.entries(user.config)) {
    if (!(key in defaults)) {
      warn(
        pkg,
        `未知配置项 '${key}'（不在扩展配置定义中）— 这是 reload 后会触发 "unknown setting" 警告的最常见原因`,
      );
      continue;
    }
    const expectedType = defaults[key];
    const actualType =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (expectedType && expectedType !== actualType) {
      warn(pkg, `配置项 '${key}' 类型应为 ${expectedType}，实际 ${actualType}`);
    }
  }
}

console.log("=".repeat(72));
console.log("  config:validate 汇总");
console.log("=".repeat(72));

if (errors.length === 0 && warnings.length === 0) {
  console.log("✓ 无问题：所有用户 config.json 解析正常，键名与类型都合法。");
  process.exit(0);
}

if (errors.length > 0) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors) console.log("  " + e);
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log("  " + w);
}

console.log("\n修复后再跑一次 config:validate 直到无 error。");
console.log(
  "warning 提示未知配置项 / 类型不匹配 — 通常是配置领先于扩展版本，或手敲时拼错。",
);

process.exit(errors.length > 0 ? 1 : 0);
