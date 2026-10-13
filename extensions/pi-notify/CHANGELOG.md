# Changelog

## 0.3.0

- **行为变更**：新增系统通知命令路径。终端没有通知协议时（如 JetBrains 内嵌终端），扩展不再静默丢弃，而是启动系统通知命令；已识别终端的 OSC 路径不变，`PI_NOTIFY_PROTOCOL=bell` / `off` / `osc9` / `osc99` / `osc777` 可显式关掉这次降级。
- 识别 JetBrains 内嵌终端（`TERMINAL_EMULATOR=JetBrains-JediTerm`；该终端只实现 OSC 9;4 进度，没有桌面通知协议），并让 `TERMINAL_EMULATOR` 优先于可能是从外层 shell 继承来的 `TERM_PROGRAM`，修掉“从 Ghostty 启动 IDEA 时被误判为 Ghostty、OSC 9 被忽略”的静默失败路径。
- 新增 `PI_NOTIFY_COMMAND` / `PI_NOTIFY_COMMAND_ARGS`（JSON 字符串数组，支持 `{title}` / `{body}` 占位符）；未配置时 macOS 用 `/usr/bin/osascript`、Linux 用 `notify-send`，Windows 没有内置后端，需显式配置。
- 通知文本始终以 argv 数据传递：不经过 shell，也不拼接进 AppleScript 源码（osascript 用 `on run argv` 接收标题与正文），正文里的引号、反引号、`$( )`、分号只能作为文本出现；命令带 5 秒超时且不重试。
- 诊断新增系统后端名称与最近一次的退出码 / 错误输出，便于区分“交出去了”和“程序跑失败了”。
- 测试脚本改为 glob（`tsx --test *.test.ts`），新增 `notifier.test.ts`（后端选择与 argv 拼装）与系统路径的集成测试（运行、失败、无法启动、非交互隔离、显式覆盖）。
- 修正 DESIGN.md 中过时的协议表（曾把 `osascript` / `powershell` / `notify-send` 写成协议名，实际协议是 OSC / bell / system）。

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
