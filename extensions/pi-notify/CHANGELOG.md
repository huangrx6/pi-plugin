# Changelog

## 0.2.1

- Make `/notify` open a concise daily view with enablement, terminal readiness, last run, and last send. Move protocol, transport, output mode, and environment notes behind “查看终端诊断”; keep `/notify status` as the direct diagnostic entry.
- Keep RPC output non-interactive and terminal-byte-free even when dialog APIs exist. Continue using Pi's native selector and current theme in TUI mode.
- Strip full CSI/OSC sequences and bidi controls from rendered text. Truncate notification payloads by grapheme-aware terminal display width so Chinese, combining characters, and emoji are not split or miscounted.

## 0.2.0

- `/notify` opens an independent diagnostic panel with terminal, protocol, transport, last result, test notification and session mute controls. Keep `/notify <message>` compatibility and add an explicit `test` form.
- Separate Ghostty/iTerm2 OSC 9, Kitty OSC 99 and WezTerm OSC 777 from transport selection. Use native Zellij forwarding, tmux DCS escaping, and screen's own DCS wrapper; use Kitty's OSC 9 compatibility in screen.
- Stop guessing OSC 777 for unknown terminals. Add explicit protocol/transport overrides, bell/off fallbacks and actionable diagnostics for ambiguous or unsupported routes.
- Write terminal bytes only in TUI mode with a real TTY; never leak OSC into RPC, JSON, print or redirected output.
- Notify after settlement, preserving counters across retries and queued continuations. Determine failure from the final assistant result rather than historical tool errors; keep aborted runs quiet and visible in diagnostics.
- Sanitize notification payloads, cap Unicode code points and assign unique Kitty notification IDs.
- Add protocol matrix, byte-level, lifecycle and interaction tests without sending real desktop notifications. Require Pi >=0.84.3 for the runtime APIs used.

## 0.1.0

Initial release.

- One-line OSC 777 / OSC 9 / OSC 99 terminal notification on `agent_settled`.
- Single-line body format with `✓` / `✗` status, turn count, tool count
  (with unique-tools sub-count), error count, duration, and session name.
- Body length capped at 240 characters; long session names are truncated
  with `…`.
- DCS passthrough for tmux (`TMUX`), Zellij (`ZELLIJ` /
  `ZELLIJ_SESSION_NAME`), and GNU screen (`STY`).
- TUI fallback notice on unsupported terminals (Apple Terminal,
  Alacritty, native Windows console) instead of a silent no-op.
- `/notify [message]` command for one-shot install verification.
- Zero runtime dependencies. Type-only import of the pi runtime.
