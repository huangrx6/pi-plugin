#!/usr/bin/env node
/** Offline migration of this repository's global extension data. No extension imports. */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const usage = `用法: node bin/migrate-data.mjs [--agent-dir <目录>] [--dry-run | --apply]

默认仅预览；--apply 前请退出所有正在使用该目录的 Pi 进程。
全局配置和数据迁入 extensions-data/<扩展名>/。
context-qos 配置转换为 pi-auto-compact/config.json，完整旧目录保留在
extensions-data/.backups/pi-context-qos/；已有新配置不会覆盖。
自定义存储路径、项目配置和 Pi 自身文件不迁移。遇到冲突不会覆盖。`;

function expandHome(value) {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function parseArgs(args) {
  let agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  let mode;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--agent-dir") {
      agentDir = args[++i];
      if (!agentDir || agentDir.startsWith("--")) throw new Error("--agent-dir 需要目录参数。");
    } else if (arg === "--apply" || arg === "--dry-run") {
      if (mode && mode !== arg) throw new Error("--apply 和 --dry-run 不能同时使用。");
      mode = arg;
    } else throw new Error(`未知参数: ${arg}`);
  }
  return { agentDir: resolve(expandHome(agentDir)), apply: mode === "--apply" };
}

function stat(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertDirectoryChain(path, boundary) {
  let current = path;
  while (current.length >= boundary.length) {
    const info = stat(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(`目录位置被文件或符号链接占用: ${current}`);
    }
    if (current === boundary) break;
    current = dirname(current);
  }
}

function readConfig(source) {
  const info = stat(source);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`配置必须是普通文件: ${source}`);
  const original = readFileSync(source);
  let config;
  try { config = JSON.parse(original.toString("utf8")); }
  catch { throw new Error(`配置不是有效 JSON，请先修复: ${source}`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`配置必须是 JSON 对象: ${source}`);
  }
  return { original, config, mode: info.mode & 0o777 };
}

function compactConfig(source) {
  if (!source) return Buffer.from(`${JSON.stringify({ enabled: true, thresholdPercent: 60 }, null, 2)}\n`);
  const config = readConfig(source).config;
  const invalid = (key) => { throw new Error(`旧配置 ${key} 的类型或范围无效，请先修复: ${source}`); };
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") invalid("enabled");
  if (config.budget !== undefined && (!config.budget || typeof config.budget !== "object" || Array.isArray(config.budget))) invalid("budget");
  const budget = config.budget ?? {};
  if (budget.nativeCompactFallback !== undefined && typeof budget.nativeCompactFallback !== "boolean") invalid("budget.nativeCompactFallback");
  function ratio(key, fallback, positive = false) {
    const value = budget[key] === undefined ? fallback : budget[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1 || (positive && value === 0)) invalid(`budget.${key}`);
    return value;
  }
  const critical = ratio("critical", 0.92, true);
  const outputReserve = ratio("outputReserveRatio", 0.12);
  const safetyReserve = ratio("safetyReserveRatio", 0.06);
  if (outputReserve + safetyReserve >= 0.8) invalid("budget.outputReserveRatio + budget.safetyReserveRatio");
  const thresholdPercent = Number((critical * (1 - outputReserve - safetyReserve) * 100).toFixed(8));
  if (thresholdPercent <= 0 || thresholdPercent >= 100) invalid("压缩阈值");
  return Buffer.from(`${JSON.stringify({ enabled: config.enabled !== false && budget.nativeCompactFallback !== false, thresholdPercent }, null, 2)}\n`);
}

function rewritePolicyConfig(source, agentDir) {
  const { original, config } = readConfig(source);
  const value = config.historyFile;
  if (typeof value !== "string") return { original, updated: original, rewritten: false };
  const expanded = expandHome(value);
  // Relative custom paths must retain their original meaning.
  if (!isAbsolute(expanded) || resolve(expanded) !== join(agentDir, "policy-engine", "history.jsonl")) {
    return { original, updated: original, rewritten: false };
  }
  config.historyFile = join(agentDir, "extensions-data", "pi-policy-engine", "state", "history.jsonl");
  return { original, updated: Buffer.from(`${JSON.stringify(config, null, 2)}\n`), rewritten: true };
}

function planMigration(agentDir) {
  const targetRoot = join(agentDir, "extensions-data");
  const operations = [];
  const contextRoots = [join(targetRoot, "pi-context-qos"), join(agentDir, "context-qos")].filter((path) => stat(path));
  if (contextRoots.length > 1) throw new Error("两处旧 context-qos 目录同时存在，请先确认应保留的数据；不会自动合并。");
  if (contextRoots.length) {
    const source = contextRoots[0];
    const info = stat(source);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`旧路径必须是普通目录: ${source}`);
    const destination = join(targetRoot, ".backups", "pi-context-qos");
    const configTarget = join(targetRoot, "pi-auto-compact", "config.json");
    assertDirectoryChain(dirname(source), agentDir);
    assertDirectoryChain(dirname(destination), agentDir);
    assertDirectoryChain(dirname(configTarget), agentDir);
    if (stat(destination)) throw new Error(`备份目标已存在，迁移已取消，不会覆盖: ${destination}`);
    const configSource = join(source, "config.json");
    // Validate the old configuration even when an existing new config takes precedence.
    const converted = compactConfig(stat(configSource) ? configSource : undefined);
    const configInfo = stat(configTarget);
    if (configInfo && (!configInfo.isFile() || configInfo.isSymbolicLink())) throw new Error(`新配置位置被其他类型占用: ${configTarget}`);
    if (!configInfo) operations.push({ type: "create", source: configSource, destination: configTarget, bytes: converted, mode: 0o600 });
    operations.push({ type: "move", source, destination, mode: info.mode & 0o777 });
  }
  const entries = [
    ["policy-engine.json", "pi-policy-engine/config.json", "file", "policy"],
    ["policy-engine", "pi-policy-engine/state", "directory"],
    ["mode-switcher.json", "pi-mode-switcher/config.json", "file", "mode"],
    ["pi-todo", "pi-todo/state", "directory"],
  ];
  for (const [oldName, newName, type, kind] of entries) {
    const source = join(agentDir, oldName);
    const destination = join(targetRoot, newName);
    const info = stat(source);
    if (!info) continue;
    if (info.isSymbolicLink() || (type === "file" ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`旧路径类型不符合预期，需手动处理: ${source}`);
    }
    assertDirectoryChain(dirname(source), agentDir);
    assertDirectoryChain(dirname(destination), agentDir);
    if (stat(destination)) throw new Error(`目标已存在，迁移已取消，不会合并或覆盖: ${destination}`);
    const config = kind === "policy" ? rewritePolicyConfig(source, agentDir) : undefined;
    if (kind === "mode") readConfig(source);
    operations.push({ type: "move", source, destination, config, mode: info.mode & 0o777 });
  }
  return operations;
}

function checkDatabaseOffline(agentDir) {
  const roots = [join(agentDir, "context-qos"), join(agentDir, "extensions-data", "pi-context-qos"), join(agentDir, "extensions-data", "pi-context-qos", "state")];
  const files = roots.flatMap((root) => {
    const database = join(root, "context.db");
    return [database, `${database}-wal`, `${database}-shm`];
  }).filter(existsSync);
  if (!files.length) return;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("当前平台无法自动确认 SQLite 已关闭；请退出 Pi 后手动迁移，勿移动正在使用的数据库。");
  }
  const result = spawnSync("lsof", ["-t", "--", ...files], { encoding: "utf8", timeout: 10_000 });
  if (result.error || result.signal || ![0, 1].includes(result.status) || result.stderr.trim()) {
    throw new Error("无法通过 lsof 确认数据库已关闭。请安装/修复 lsof，并退出 Pi 后重试。");
  }
  if (result.stdout.trim()) {
    const pids = [...new Set(result.stdout.trim().split(/\s+/))].join(", ");
    throw new Error(`context 数据库仍被进程 ${pids} 使用。请退出所有 Pi 进程后重新执行 --apply。`);
  }
}

function writeAtomic(path, bytes, mode) {
  const temporary = `${path}.migration-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function applyMigration(agentDir) {
  checkDatabaseOffline(agentDir);
  const createdDirectories = [];
  const completed = [];
  function ensureDirectory(path) {
    if (stat(path)) return;
    ensureDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
    createdDirectories.push(path);
  }
  try {
    // Complete every expected conflict check before the first filesystem mutation.
    const operations = planMigration(agentDir);
    for (const operation of operations) {
      ensureDirectory(dirname(operation.destination));
      if (operation.type === "create") {
        const descriptor = openSync(operation.destination, "wx", operation.mode);
        completed.push(operation);
        try { writeFileSync(descriptor, operation.bytes); }
        finally { closeSync(descriptor); }
      } else {
        renameSync(operation.source, operation.destination);
        completed.push(operation);
      }
      if (operation.config?.rewritten) writeAtomic(operation.destination, operation.config.updated, operation.mode);
    }
  } catch (error) {
    const failures = [];
    for (const operation of completed.reverse()) {
      try {
        if (operation.type === "create") unlinkSync(operation.destination);
        else {
          if (operation.config?.rewritten) writeAtomic(operation.destination, operation.config.original, operation.mode);
          renameSync(operation.destination, operation.source);
        }
      } catch (rollbackError) { failures.push(`${operation.destination}: ${rollbackError.message}`); }
    }
    for (const path of createdDirectories.reverse()) {
      try { rmdirSync(path); } catch { /* Only remove empty directories created by this run. */ }
    }
    if (failures.length) {
      throw new Error(`${error.message}\n部分回滚失败，请保留全部文件并手动恢复:\n${failures.join("\n")}`);
    }
    throw new Error(`${error.message}\n本次移动已回滚。`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) console.log(usage);
  else {
    const operations = planMigration(options.agentDir);
    if (!operations.length) console.log("没有需要迁移的旧配置或数据。");
    else {
      console.log(options.apply ? "离线迁移计划:" : "迁移预览（未修改文件）:");
      for (const operation of operations) {
        console.log(`  ${operation.source}\n    → ${operation.destination}${operation.type === "create" ? "（转换压缩配置；旧原件保留于备份）" : operation.config?.rewritten ? "（更新旧默认路径配置）" : ""}`);
      }
      if (options.apply) {
        applyMigration(options.agentDir);
        console.log("迁移完成。重新启动 Pi 后使用新目录。旧归档备份不会被新扩展读取或写入。");
      } else console.log("请退出所有 Pi 进程，再加 --apply 执行。自定义存储目录不会移动或删除。");
    }
  }
} catch (error) {
  console.error(`迁移失败: ${error.message}`);
  process.exitCode = 1;
}
