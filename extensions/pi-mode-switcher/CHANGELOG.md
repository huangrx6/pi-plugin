# Changelog

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
