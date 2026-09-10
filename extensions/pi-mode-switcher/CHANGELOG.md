# Changelog

## 0.4.0 - 2026-09-10

- 模式选择器只显示中文名称与说明，不再暴露内部 `ask`、`smart`、`full` key。
- 菜单名称与说明统一为“请求批准”“帮我批准”“完全访问权限”三档。
- Footer 状态改为简短的中文模式，状态 key 改为扩展自有名称，不再遵循外部分类协议。
- 直接命令同时接受中文名称；英文参数继续作为脚本输入使用，但不在界面展示。

## 0.3.0 - 2026-09-05

- Remove the retired `mode-switcher.json` fallback. The extension now reads and writes only `extensions-data/pi-mode-switcher/config.json`, so configuration ownership is unambiguous.

## 0.2.1 - 2026-09-04

- Move persisted mode to `extensions-data/pi-mode-switcher/config.json` under the agent directory and respect `PI_CODING_AGENT_DIR`.
- Read the legacy config only when the new config is absent; create parent directories on save.

## 0.2.0 - 2026-09-04

- Align the command with the terminal UI contract: cancelling `/mode` is silent, switch confirmations use a concise Chinese hierarchy, and the optional status is plain themed text instead of hard-coded ANSI colors.
- Sanitize and display-width-truncate command, path, URL, query and unknown-mode text before it enters terminal confirmation or selection dialogs.
- Add CJK width and terminal-control regression tests.

## 0.1.2 - 2026-08-27

- Status icon ◈ → ⚙ (the diamond rendered visually smaller than the other footer icons; the gear matches the weight of ⚡/🔌).

## 0.1.1 - 2026-08-27

- Fix a security hole: composite commands bypassed approval entirely. `isWriteBash` / `isRiskyBash` anchored every rule at the command start, so `echo hi && rm -rf /x` was judged read-only and passed without prompting in **both** ask and smart modes — despite the README promising "missed cases default to write". Commands are now split on `&&` / `||` / `;` / `|` / newlines plus `$( )` and backtick substitution bodies, each segment is analyzed independently, and any segment that cannot be proven read-only (via a read-only command whitelist, including read-only git queries) makes the whole composite a write. Piping into an interpreter (`curl … | sh`) is now flagged risky as remote code execution.
- Replace the pointless lazy `require("node:fs")` (the module already read its config at load time) with a static import; collapse five scattered `ctx as unknown as UiCtx` casts into one documented `uiOf` helper.
- Add test infrastructure (tsconfig + ambient shim + `npm run check` / `npm test`) per the repo convention; composite-command regression tests included.

## 0.1.0 - 2026-08-27

- Three-mode approval gate (ask / smart / full) for every tool call, persisted across sessions, with a footer status line.
