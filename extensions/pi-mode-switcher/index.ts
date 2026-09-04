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
 * Mode persists across sessions and publishes an optional status summary.
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

import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatInline } from "./display.ts";

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

// Read-only tools (always pass in every mode).
const READ_TOOLS = new Set(["read", "ls", "grep", "find", "glob"]);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH = `${process.env.HOME ?? process.env.USERPROFILE}/.pi/agent/mode-switcher.json`;

function loadPersistedMode(): Mode {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return parsed.mode === "ask" ||
      parsed.mode === "smart" ||
      parsed.mode === "full"
      ? (parsed.mode as Mode)
      : "smart";
  } catch {
    return "smart";
  }
}

function persistMode(mode: Mode): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ mode }, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Mode state
// ---------------------------------------------------------------------------

let currentMode: Mode = loadPersistedMode();

// ---------------------------------------------------------------------------
// Risk detection
// ---------------------------------------------------------------------------

/**
 * Split a composite command into independently-analyzable segments.
 * Separators: && || ; | newlines, plus $( ) and ` ` substitution bodies so
 * they are still analyzed. Crude on nested substitutions — that is
 * deliberate: the composite safety net below treats anything not
 * provably read-only as a write, so under-decomposition errs toward
 * asking (the README promise: missed cases default to the safer side).
 */
export function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .flatMap((seg) => seg.split(/`([^`]*)`/).filter((s) => s && s.trim()))
    .flatMap((seg) => seg.split("$(").map((s) => s.replace(/\)$/, "")))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Write heuristics for a SINGLE command segment (no separators inside). */
function segWriteBash(c: string): boolean {
  if (
    /^(rm|mv|cp|mkdir|touch|chmod|chown|dd|ln|truncate|install|patch)\b/.test(c)
  )
    return true;
  if (/[>»]/.test(c) && !/[>»]\s*\/dev\/null/.test(c)) return true;
  if (/\b(tee|sed\s+-i)\b/.test(c)) return true;
  if (
    /^git\s+(commit|push|reset|rebase|merge|checkout|restore|clean|stash|tag|branch\s+-[dD])\b/.test(
      c,
    )
  )
    return true;
  if (
    /^(npm|yarn|pnpm|pip|pip3|poetry|cargo|go|brew|apt|apt-get|yum|dnf)\s+(install|add|remove|uninstall|publish|update|upgrade)\b/.test(
      c,
    )
  )
    return true;
  if (/^(curl|wget|ssh|scp|rsync|nc|nmap)\b/.test(c)) return true;
  return false;
}

/**
 * Read-only segment whitelist — used ONLY as the composite safety net.
 * A segment counts as provably read-only only when it starts with a
 * known read-only command AND carries no hidden mutating word in its
 * arguments (e.g. `xargs rm` is whitelisted by prefix but fails the
 * keyword check).
 */
const READONLY_SEGS =
  /^(ls|cat|head|tail|less|grep|rg|find|wc|pwd|whoami|uname|date|echo|printf|true|false|which|type|file|du|df|stat|id|env|printenv|sleep|basename|dirname|realpath|sort|uniq|cut|awk|sed|tr|xargs)\b|^git\s+(status|log|diff|show|blame|branch|tag|remote|rev-parse|reflog|ls-files|ls-remote|shortlog|describe|stash\s+(list|show))\b/;
const HIDDEN_MUTATORS =
  /\b(rm|mv|cp|chmod|chown|dd|tee|sudo|mkfifo|shred|install|patch|truncate|curl|wget|ssh)\b/;

function segProvablyReadOnly(seg: string): boolean {
  return READONLY_SEGS.test(seg) && !HIDDEN_MUTATORS.test(seg);
}

function isComposite(cmd: string): boolean {
  return /&&|\|\||;|\||\n|\$\(|`/.test(cmd);
}

/** Is a bash command a write operation? Composite-aware heuristic. */
export function isWriteBash(cmd: string): boolean {
  const segments = splitSegments(cmd);
  for (const seg of segments) {
    if (segWriteBash(seg)) return true;
  }
  // Composite safety net: any segment we cannot PROVE read-only makes
  // the whole composite a write. Single non-composite commands keep the
  // original blacklist behaviour (changing that would prompt on every
  // `python3 x.py` — a UX decision beyond this bug fix).
  if (isComposite(cmd)) {
    return segments.some((seg) => !segProvablyReadOnly(seg));
  }
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
    if (t === "/" || t === "/*" || t === "." || t === ".." || t === "~")
      return true;
    if (t === "*" || t === ".*" || t === "/*.*") return true;
    if (t.includes("*")) return true;
    return false;
  });
}

/** High-risk heuristics for a SINGLE command segment. */
function segRiskyBash(c: string): boolean {
  if (
    /^rm\b/.test(c) &&
    (/(\s|^)(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)(\s|$)/.test(c) ||
      rmTargetsRisky(c))
  )
    return true;
  if (/^(mkfs|fdisk|parted)\b/.test(c)) return true;
  if (/^dd\b.*\bof=\/dev\//.test(c)) return true;
  if (
    /^git\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+--force(\s|$)|push\s+-f(\s|$))/.test(
      c,
    )
  )
    return true;
  if (/\bsudo\b/.test(c)) return true;
  if (/\bchmod\s+(-[a-zA-Z]*\s+)*-?R?[0-7]{3,4}\s+\/(\s|$)/.test(c))
    return true;
  if (/\bmkfifo\b|\bshred\b/.test(c)) return true;
  return false;
}

/** Is a bash command high-risk / irreversible? Composite-aware. */
export function isRiskyBash(cmd: string): boolean {
  const segments = splitSegments(cmd);
  if (segments.some((seg) => segRiskyBash(seg))) return true;
  // Piping anything into an interpreter is remote code execution
  // (`curl … | sh`) — flag the interpreter segment when a pipe exists.
  if (cmd.includes("|")) {
    return segments.some((seg) =>
      /^(sh|bash|zsh|fish|python3?|node|ruby|perl)\b/.test(seg),
    );
  }
  return false;
}

/** Short human description of a tool call for the confirm dialog. */
function describeCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return `执行命令 · ${formatInline(cmd, 108)}`;
  }
  const path = typeof input.path === "string" ? input.path : "";
  if (path) return `${formatInline(toolName, 24)} → ${formatInline(path, 92)}`;
  if (typeof input.url === "string")
    return `${formatInline(toolName, 24)} → ${formatInline(input.url, 92)}`;
  if (typeof input.query === "string")
    return `${formatInline(toolName, 24)} → ${formatInline(input.query, 92)}`;
  return formatInline(toolName, 120);
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
  const command =
    isBash && typeof input.command === "string" ? input.command : "";

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
// Optional status summary
// ---------------------------------------------------------------------------

type UiCtx = {
  ui: {
    setStatus: (k: string, text: string | undefined) => void;
    notify: (msg: string, type?: string) => void;
    select: (title: string, options: string[]) => Promise<string | undefined>;
    confirm: (title: string, message: string) => Promise<boolean>;
  };
};

/**
 * SAFETY: pi's event ctx is a wide structural type at runtime; UiCtx is
 * the narrow slice this extension touches (ui.notify / select / confirm /
 * setStatus). The extension contract guarantees those methods exist on
 * every event ctx, and mode-switcher never reads any other property —
 * so this single cast point replaces five scattered ones.
 */
function uiOf(ctx: unknown): UiCtx {
  return ctx as UiCtx;
}

function buildModeText(): string {
  return `⚙ 权限 ${currentMode}`;
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
    ctx.ui.notify(`权限模式 · ${MODE_LABELS[currentMode]}`, "info");
    renderStatus(ctx);
  }

  // ── /mode command ──
  pi.registerCommand("mode", {
    description: "切换权限模式: ask | smart | full",
    handler: async (args, ctx) => {
      const uiCtx = uiOf(ctx);
      const name = args.trim().toLowerCase();
      const valid: Mode[] = ["ask", "smart", "full"];

      // With a valid argument: switch directly.
      if (valid.includes(name as Mode)) {
        switchMode(name as Mode, uiCtx);
        return;
      }

      // No argument (or an unrecognized one): interactive selector.
      const options = valid.map(
        (m) => `${m} — ${MODE_LABELS[m]}：${MODE_ZH[m]}`,
      );
      const choice = await ctx.ui.select(
        name
          ? `选择权限模式（当前：${MODE_LABELS[currentMode]}；未识别“${formatInline(name, 20)}”）`
          : `选择权限模式（当前: ${MODE_LABELS[currentMode]}）`,
        options,
      );
      if (choice === undefined) return;
      // select() returns the chosen option text; extract the mode key prefix.
      const picked = String(choice)
        .split(/[\s—:]/)[0]
        .toLowerCase();
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
      (title, message) => uiOf(ctx).ui.confirm(title, message),
    );
    if (reason) {
      return { block: true, reason, terminate: false };
    }
    return undefined; // allow
  });

  // ── Status refresh ──
  // Multiple set points: pi clears extension statuses on session invalidate
  // (without reloading this module), so we re-set on every natural event.
  // setStatus is an O(1) map write — re-setting is free.
  pi.on("session_start", async (_event, ctx) => {
    renderStatus(uiOf(ctx));
  });

  pi.on("session_tree", async (_event, ctx) => {
    renderStatus(uiOf(ctx));
  });

  pi.on("turn_end", async (_event, ctx) => {
    renderStatus(uiOf(ctx));
  });
}
