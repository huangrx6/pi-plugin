/**
 * pi-notify — single-line OSC 777/9/99 terminal notifications for pi.
 *
 * Sends a one-line OSC notification when the agent settles (after every
 * queued follow-up has resolved, not after every low-level run — so users
 * don't get spammed during retry / compaction). The body is formatted with
 * Unicode characters only (no emoji) so it renders the same in monospace
 * fonts across macOS / Linux distros and SSH sessions.
 *
 * Supported terminals:
 *   - Ghostty / iTerm2          → OSC 9  (desktop notification banner)
 *   - WezTerm / rxvt-unicode    → OSC 777 (urxvt-style notify)
 *   - Kitty                     → OSC 99 (Kitty's notification protocol)
 *
 * Supported multiplexers (DCS passthrough so OSC survives):
 *   - tmux   (TMUX env)
 *   - zellij (ZELLIJ / ZELLIJ_SESSION_NAME env)
 *   - screen (STY env)
 *
 * Unsupported terminals (Apple Terminal, Alacritty, native win32 console
 * outside WSL) get a TUI notice recommending filing an issue, instead of
 * a silent no-op.
 *
 * Zero runtime dependencies: pi is type-only; OSC writes go straight to
 * process.stdout.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ── OSC primitives ─────────────────────────────────────────────────────

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`; // String Terminator (OSC 99 / DCS passthrough end)

/** Wrap an OSC sequence for DCS passthrough inside tmux / zellij / screen.
 *  All inner ESC bytes are doubled so the multiplexer forwards the
 *  sequence verbatim to the host terminal. */
export function wrapForMultiplexer(seq: string): string {
  if (
    !process.env.TMUX &&
    !process.env.ZELLIJ &&
    !process.env.ZELLIJ_SESSION_NAME &&
    !process.env.STY
  ) {
    return seq;
  }
  const escaped = seq.split(ESC).join(`${ESC}${ESC}`);
  return `${ESC}Ptmux;${escaped}${ST}`;
}

export function notifyOSC777(title: string, body: string): void {
  const seq = `${ESC}]777;notify;${title};${body}${BEL}`;
  process.stdout.write(wrapForMultiplexer(seq));
}

export function notifyOSC9(message: string): void {
  const seq = `${ESC}]9;${message}${BEL}`;
  process.stdout.write(wrapForMultiplexer(seq));
}

export function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: two-part notification (id+title, then body payload)
  const titleSeq = `${ESC}]99;i=1:d=0;${title}${ST}`;
  const bodySeq = `${ESC}]99;i=1:p=body;${body}${ST}`;
  process.stdout.write(wrapForMultiplexer(titleSeq));
  process.stdout.write(wrapForMultiplexer(bodySeq));
}

type Sender = (title: string, body: string) => void;

export function isUnsupportedTerminal(): boolean {
  if (process.env.TERM_PROGRAM === "Apple_Terminal") return true;
  const term = (process.env.TERM ?? "").toLowerCase();
  if (term.includes("alacritty")) return true;
  // Native win32 console: not supported. WSL + Windows Terminal falls through
  // to OSC 777 via detectSender() (WT_SESSION is set there).
  if (process.platform === "win32" && !process.env.WT_SESSION) return true;
  return false;
}

export function detectSender(): Sender | null {
  if (isUnsupportedTerminal()) return null;

  if (process.env.KITTY_WINDOW_ID) return notifyOSC99;

  const termProgram = process.env.TERM_PROGRAM ?? "";
  if (
    termProgram === "ghostty" ||
    termProgram === "iTerm.app" ||
    process.env.ITERM_SESSION_ID
  ) {
    return (title, body) => notifyOSC9(`${title}: ${body}`);
  }

  // Default: OSC 777 (WezTerm, rxvt-unicode, Windows Terminal under WSL).
  return notifyOSC777;
}

// ── Formatting ─────────────────────────────────────────────────────────

const MAX_BODY_CHARS = 240;

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

interface RunStats {
  turns: number;
  toolCalls: number;
  errors: number;
  uniqueTools: Set<string>;
  startedAt: number;
}

function freshStats(): RunStats {
  return {
    turns: 0,
    toolCalls: 0,
    errors: 0,
    uniqueTools: new Set(),
    startedAt: Date.now(),
  };
}

export function formatBody(
  stats: RunStats,
  sessionName: string | null,
): string {
  const icon = stats.errors > 0 ? "\u2717" : "\u2713"; // ✗ / ✓
  const parts: string[] = [`${icon} Pi`];

  if (stats.turns === 1) parts.push("1 turn");
  else if (stats.turns > 1) parts.push(`${stats.turns} turns`);

  if (stats.toolCalls > 0) {
    const unique = stats.uniqueTools.size;
    const callWord = stats.toolCalls === 1 ? "tool" : "tools";
    parts.push(`${stats.toolCalls} ${callWord} (${unique} unique)`);
  }

  if (stats.errors > 0) {
    parts.push(`${stats.errors} ${stats.errors === 1 ? "error" : "errors"}`);
  }

  parts.push(formatDuration(Date.now() - stats.startedAt));

  let body = parts.join(" \u00B7 "); // · separator

  if (sessionName && sessionName.trim().length > 0) {
    const suffix = ` \u00B7 ${sessionName.trim()}`;
    if (body.length + suffix.length <= MAX_BODY_CHARS) {
      body += suffix;
    } else {
      const room = Math.max(0, MAX_BODY_CHARS - body.length - 4); // 4 = " · …"
      if (room > 0) {
        body += ` \u00B7 ${sessionName.trim().slice(0, room)}\u2026`;
      }
    }
  }

  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS - 1) + "\u2026";
  }

  return body;
}

// ── Extension factory ──────────────────────────────────────────────────

const TITLE = "Pi";
const UNSUPPORTED_MSG =
  "OSC notifications unsupported in this terminal. " +
  "Please file an issue at https://github.com/huangrx6/pi-plugin/issues";

export default function (pi: ExtensionAPI): void {
  let stats = freshStats();

  function sendNotification(ctx: ExtensionContext, body: string): void {
    const sender = detectSender();
    if (!sender) {
      ctx.ui.notify(UNSUPPORTED_MSG, "info");
      return;
    }
    sender(TITLE, body);
  }

  pi.on("agent_start", () => {
    stats = freshStats();
  });

  pi.on("turn_end", () => {
    stats.turns++;
  });

  pi.on("tool_execution_end", (event) => {
    const e = event as { toolName?: string; isError?: boolean };
    if (typeof e.toolName === "string") {
      stats.toolCalls++;
      stats.uniqueTools.add(e.toolName);
      if (e.isError) stats.errors++;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    const sessionName = ctx.sessionManager?.getSessionName?.() ?? null;
    sendNotification(ctx, formatBody(stats, sessionName));
  });

  pi.registerCommand("notify", {
    description:
      "Send a one-shot OSC terminal notification (Ghostty / iTerm2 / WezTerm / Kitty).",
    handler: (args, ctx) => {
      const msg = args.trim() || "Waiting for your input";
      sendNotification(ctx, `\u270D Pi \u00B7 ${msg}`);
    },
  });
}
