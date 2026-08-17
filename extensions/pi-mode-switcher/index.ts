/**
 * pi-mode-switcher — three-level approval control for pi
 *
 * Three modes (like Claude Code's permission levels):
 *
 *   ask   — 请求批准: edits & risky bash always ask via confirm dialog
 *   smart — 帮我批准: auto-approve everything except detected risky operations
 *   full  — 完全访问: never ask, everything passes
 *
 * Pure pi-native: tool_call event interception + ctx.ui.confirm() dialogs.
 * Zero third-party dependencies.
 *
 * `/mode` opens an interactive selector with Chinese descriptions.
 * Mode persists across sessions and shows in the footer status row.
 *
 * Robustness notes:
 *  - The footer status is re-set on session_start, session_tree AND turn_end:
 *    pi clears extension statuses on session invalidate without reloading
 *    this module, so a single set point would leave the mode gone until a
 *    manual re-switch. turn_end re-set is O(1) and self-heals any wipe.
 *  - `rm` risk detection analyzes argument tokens instead of raw regex on
 *    the whole command, so `rm ./x` / `rm ~/x` don't false-positive while
 *    `rm /`, `rm /*`, and wildcard deletes are still caught.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type Mode = "ask" | "smart" | "full";

const MODE_LABELS: Record<Mode, string> = {
  ask: "请求批准",
  smart: "帮我批准",
  full: "完全访问",
};

const MODE_ZH: Record<Mode, string> = {
  ask: "编辑外部文件和使用互联网时始终询问",
  smart: "仅对检测到的风险操作请求批准",
  full: "不需要我批准任何请求",
};

// ANSI colors
const C = {
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

const MODE_COLOR: Record<Mode, string> = {
  ask: C.cyan,
  smart: C.yellow,
  full: C.red,
};

// Tools that write to the filesystem (need approval in ask mode).
const WRITE_TOOLS = new Set([
  "write", "edit", "apply_patch", "multi_edit",
  "create", "delete", "rename", "move", "append",
]);
// Read-only tools (always pass in every mode).
const READ_TOOLS = new Set(["read", "ls", "grep", "find", "glob"]);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH = `${process.env.HOME ?? process.env.USERPROFILE}/.pi/agent/mode-switcher.json`;

function loadPersistedMode(): Mode {
  try {
    const fs = requireNodeFs();
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return parsed.mode === "ask" || parsed.mode === "smart" || parsed.mode === "full"
      ? (parsed.mode as Mode)
      : "smart";
  } catch {
    return "smart";
  }
}

function persistMode(mode: Mode): void {
  try {
    requireNodeFs().writeFileSync(CONFIG_PATH, JSON.stringify({ mode }, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

let _fs: typeof import("node:fs") | null = null;
function requireNodeFs(): typeof import("node:fs") {
  if (!_fs) _fs = require("node:fs") as typeof import("node:fs");
  return _fs;
}

// ---------------------------------------------------------------------------
// Mode state
// ---------------------------------------------------------------------------

let currentMode: Mode = loadPersistedMode();

// ---------------------------------------------------------------------------
// Risk detection
// ---------------------------------------------------------------------------

/** Is a bash command a write operation? (heuristic) */
function isWriteBash(cmd: string): boolean {
  const c = cmd.trim();
  if (/^(rm|mv|cp|mkdir|touch|chmod|chown|dd|ln|truncate|install|patch)\b/.test(c)) return true;
  if (/[>»]/.test(c) && !/[>»]\s*\/dev\/null/.test(c)) return true;
  if (/\b(tee|sed\s+-i)\b/.test(c)) return true;
  if (/^git\s+(commit|push|reset|rebase|merge|checkout|restore|clean|stash|tag|branch\s+-[dD])\b/.test(c)) return true;
  if (/^(npm|yarn|pnpm|pip|pip3|poetry|cargo|go|brew|apt|apt-get|yum|dnf)\s+(install|add|remove|uninstall|publish|update|upgrade)\b/.test(c)) return true;
  // Network access (internet usage).
  if (/^(curl|wget|ssh|scp|rsync|nc|nmap)\b/.test(c)) return true;
  return false;
}

/**
 * Do the targets of an `rm` command look dangerous?
 * Token-based: only flag root (/), root-glob (/*), wildcards, or bare
 * `.`/`..` directory deletes. `rm ./x`, `rm ~/x`, `rm /tmp/x` are ordinary.
 */
function rmTargetsRisky(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/).slice(1);
  const targets = tokens.filter((t) => !t.startsWith("-"));
  return targets.some((t) => {
    if (t === "/" || t === "/*" || t === "." || t === ".." || t === "~") return true;
    if (t === "*" || t === ".*" || t === "/*.*") return true;
    // Wildcard deletes (foo/*, *.txt at command top level).
    if (t.includes("*")) return true;
    return false;
  });
}

/** Is a bash command high-risk / irreversible? */
function isRiskyBash(cmd: string): boolean {
  const c = cmd.trim();
  if (/^rm\b/.test(c) && (/(\s|^)(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)(\s|$)/.test(c) || rmTargetsRisky(c))) return true;
  if (/^(mkfs|fdisk|parted)\b/.test(c)) return true;
  if (/^dd\b.*\bof=\/dev\//.test(c)) return true;
  if (/^git\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+--force(\s|$)|push\s+-f(\s|$))/ .test(c)) return true;
  if (/\bsudo\b/.test(c)) return true;
  if (/\bchmod\s+(-[a-zA-Z]*\s+)*-?R?[0-7]{3,4}\s+\/(\s|$)/.test(c)) return true;
  if (/\bmkfifo\b|\bshred\b/.test(c)) return true;
  return false;
}

/** Short human description of a tool call for the confirm dialog. */
function describeCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return `执行命令: ${cmd.slice(0, 120)}`;
  }
  const path = typeof input.path === "string" ? input.path : "";
  if (path) return `${toolName} → ${path}`;
  if (typeof input.url === "string") return `${toolName} → ${input.url.slice(0, 100)}`;
  if (typeof input.query === "string") return `${toolName} → ${input.query.slice(0, 100)}`;
  return toolName;
}

// ---------------------------------------------------------------------------
// Permission check (the core logic)
// ---------------------------------------------------------------------------

type ConfirmFn = (title: string, message: string) => Promise<boolean>;

/**
 * Decide whether a tool call should proceed.
 * Returns null (allow) or a block reason (deny after user said no).
 */
async function checkPermission(
  mode: Mode,
  toolName: string,
  input: Record<string, unknown>,
  confirm: ConfirmFn,
): Promise<string | null> {
  // Read-only tools always pass.
  if (READ_TOOLS.has(toolName)) return null;

  const isBash = toolName === "bash";
  const command = isBash && typeof input.command === "string" ? input.command : "";

  // --- full: 完全访问, never ask ---
  if (mode === "full") return null;

  // --- ask: 请求批准 — whitelist strategy ---
  // Auto-allow ONLY known read-only tools and read-only bash.
  // Everything else (writes, network, MCP, unknown tools) asks via confirm.
  if (mode === "ask") {
    if (isBash && !isWriteBash(command)) {
      return null; // read-only bash passes
    }
    // bash write, write-tools, network tools (fetch/web/mcp), unknown — all ask.
    const ok = await confirm("请求批准", describeCall(toolName, input));
    return ok ? null : "用户拒绝了此操作";
  }

  // --- smart: 帮我批准, only confirm risky operations ---
  if (mode === "smart") {
    if (isBash && isRiskyBash(command)) {
      const ok = await confirm("风险操作确认", describeCall(toolName, input));
      return ok ? null : "用户拒绝了此风险操作";
    }
    return null; // everything else auto-approved
  }

  return null;
}

// ---------------------------------------------------------------------------
// Footer status
// ---------------------------------------------------------------------------

type UiCtx = {
  ui: {
    setStatus: (k: string, text: string | undefined) => void;
    notify: (msg: string, type?: string) => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    confirm: (title: string, message: string) => Promise<boolean>;
  };
};

function buildModeText(): string {
  const label = MODE_LABELS[currentMode];
  const color = MODE_COLOR[currentMode];
  return `${color}◈ mode:${label}${C.reset}`;
}

function renderStatus(ctx: UiCtx): void {
  ctx.ui.setStatus("mode", buildModeText());
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  function switchMode(mode: Mode, ctx: UiCtx): void {
    currentMode = mode;
    persistMode(currentMode);
    ctx.ui.notify(`模式已切换: ${MODE_LABELS[currentMode]}`, "info");
    renderStatus(ctx);
  }

  // ── /mode command ──
  pi.registerCommand("mode", {
    description: "切换权限模式: ask | smart | full",
    handler: async (args, ctx) => {
      const uiCtx = ctx as unknown as UiCtx;
      const name = args.trim().toLowerCase();
      const valid: Mode[] = ["ask", "smart", "full"];

      // With a valid argument: switch directly.
      if (valid.includes(name as Mode)) {
        switchMode(name as Mode, uiCtx);
        return;
      }

      // No argument (or an unrecognized one): interactive selector.
      const options = valid.map((m) => `${m} — ${MODE_LABELS[m]}：${MODE_ZH[m]}`);
      const choice = await ctx.ui.select(
        name
          ? `选择权限模式（当前: ${MODE_LABELS[currentMode]}，未识别 "${name.slice(0, 20)}"）`
          : `选择权限模式（当前: ${MODE_LABELS[currentMode]}）`,
        options,
      );
      if (choice === undefined) {
        ctx.ui.notify("已取消", "info");
        return;
      }
      // select() returns the chosen option text; extract the mode key prefix.
      const picked = String(choice).split(/[\s—:]/)[0].toLowerCase();
      if (!valid.includes(picked as Mode)) return;
      switchMode(picked as Mode, uiCtx);
    },
  });

  // ── Permission gate: intercept tool calls ──
  pi.on("tool_call", async (event, ctx) => {
    const reason = await checkPermission(
      currentMode,
      event.toolName,
      event.input as Record<string, unknown>,
      (title, message) => (ctx as unknown as UiCtx).ui.confirm(title, message),
    );
    if (reason) {
      return { block: true, reason, terminate: false };
    }
    return undefined; // allow
  });

  // ── Footer status refresh ──
  // Multiple set points: pi clears extension statuses on session invalidate
  // (without reloading this module), so we re-set on every natural event.
  // setStatus is an O(1) map write — re-setting is free.
  pi.on("session_start", async (_event, ctx) => {
    renderStatus(ctx as unknown as UiCtx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    renderStatus(ctx as unknown as UiCtx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    renderStatus(ctx as unknown as UiCtx);
  });
}
