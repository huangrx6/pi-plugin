# Changelog

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
