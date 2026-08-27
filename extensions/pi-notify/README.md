<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/notify.svg" alt="pi-notify" width="48" />
</p>

# pi-notify

<p align="center"><strong>Single-line OSC terminal notification when the Pi agent settles.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

Sends a one-line OSC notification each time the agent finishes a run and is waiting for input. Formatted with basic Unicode (no emoji) so the output looks the same in monospace fonts across macOS, Linux, and SSH sessions — including the long tail of fonts that lack emoji glyphs.

## What it adds

- **Hook**: `agent_settled` — emits one OSC notification per run, fires once per run (not per retry or queued follow-up), so you don't get spammed mid-retry
- **Command**: `/notify [message]` — one-shot test notification; defaults to `"Waiting for your input"` when called with no argument; use it to verify the extension is wired correctly after install

No tools are registered. The model does not call this extension directly.

## Output format

A single line, fields separated by ` · ` (U+00B7). Status glyph is `✓` (U+2713) on success or `✗` (U+2717) when any tool call errored:

```text
✓ Pi · 3 turns · 5 tools (3 unique) · 1m24s · feature-branch
✗ Pi · 3 turns · 5 tools (3 unique) · 1 error · 1m24s · feature-branch
✓ Pi · 1 turn · 2 tools · 0:42 · debug-session
✓ Pi · 12s · debug-session       ← 0 turns (immediate cancel)
```

Duration auto-formats:

| Range | Format |
| --- | --- |
| < 60 s | `42s` |
| < 60 min | `1m24s` |
| ≥ 60 min | `1h12m` |

The body is capped at **240 characters**. If the session name is too long to fit, it is truncated with `…`. Terminal notification protocols truncate unpredictably; truncating explicitly keeps the layout predictable.

## Terminal support

Notifications go through your terminal emulator's native OSC protocol. No OS daemons, no extra packages, no external binaries.

| Terminal | Protocol | Detection |
| --- | --- | --- |
| Ghostty | OSC 9 | `TERM_PROGRAM=ghostty` |
| iTerm2 | OSC 9 | `TERM_PROGRAM=iTerm.app` or `ITERM_SESSION_ID` |
| WezTerm | OSC 777 | default fallback |
| rxvt-unicode | OSC 777 | default fallback |
| Kitty | OSC 99 | `KITTY_WINDOW_ID` |
| Windows Terminal (WSL) | OSC 777 | `WT_SESSION` |

### Multiplexers (DCS passthrough)

OSC sequences are wrapped in DCS `ESC P tmux; … ESC \` so they survive multiplexers (which would otherwise swallow the raw OSC bytes):

| Multiplexer | Env |
| --- | --- |
| tmux | `TMUX` |
| Zellij | `ZELLIJ` or `ZELLIJ_SESSION_NAME` |
| GNU screen | `STY` |

### Unsupported terminals

Apple Terminal, Alacritty, and the native Windows console (outside WSL) do not implement any OSC notification protocol. In those environments the extension surfaces a TUI notice recommending an issue be filed, instead of emitting a silent no-op.

## Why Unicode, not emoji

Upstream packages use `✅ ❌ 🔔` for status. That looks fine on macOS with the system emoji font, but in:

- Linux distros without a Noto Color Emoji fallback
- SSH sessions with a stripped-down terminal font
- Windows Terminal in some configurations

those characters render as `?` boxes or width-doubled glyphs that break the single-line layout. `\u2713` and `\u2717` are part of every monospace font shipped with a serious terminal emulator since 2010, so we get a consistent look everywhere without making the user install fonts.

## Install

```bash
pi install git:github.com/huangrx6/pi-notify
```

Or via the monorepo. Restart Pi or `/reload`. No API keys or external configuration.

## Development

```bash
cd extensions/pi-notify
npm install
npm run check      # type-check
npm test           # format / OSC bytes / multiplexer wrapping / terminal detection / extension factory
```

Try it against a real Pi session:

```bash
pi -e ./extensions/pi-notify
```

## Requirements

- Node `>=20`
- Pi (latest)

## License

MIT © huangrx6
