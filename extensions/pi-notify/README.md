# pi-notify

Single-line OSC 777 / OSC 9 / OSC 99 terminal notifications when the pi agent
settles. Formatted with basic Unicode (no emoji) so it renders the same in
monospace fonts across macOS, Linux, and SSH sessions — including the long
tail of fonts that have no emoji glyphs.

## Install

```bash
# From the monorepo (after symlink via bin/install.sh)
pi -e ./extensions/pi-notify

# Single session, without installing
pi -e npm:pi-notify
```

## What it adds

- **Hook**: `agent_settled` — sends a one-line OSC notification each time the
  agent finishes a run and is waiting for input. Fires once per run (not per
  retry / queued follow-up), so you don't get spammed mid-retry.
- **Command**: `/notify [message]` — one-shot test notification. Defaults to
  `"Waiting for your input"` when called with no argument. Use it to verify
  the extension is wired correctly after install.

No tools are registered. The LLM does not call this extension directly.

## Output format

The body is a single line, separated by ` · ` (U+00B7). The status glyph is
`✓` (U+2713) on success or `✗` (U+2717) when any tool call errored.

```text
✓ Pi · 3 turns · 5 tools (3 unique) · 1m24s · feature-branch
✗ Pi · 3 turns · 5 tools (3 unique) · 1 error · 1m24s · feature-branch
✓ Pi · 1 turn · 2 tools · 0:42 · debug-session
✓ Pi · 12s · debug-session       ← 0 turns (immediate cancel)
```

Duration auto-formats:

| Range | Format |
| --- | --- |
| < 60s | `42s` |
| < 60m | `1m24s` |
| ≥ 60m | `1h12m` |

The body is capped at **240 characters**. If the session name is too long
to fit, it is truncated with `…`. The terminal notification protocol varies
in how it truncates; we truncate explicitly to keep the layout predictable.

## Terminal support

Notifications go through your terminal emulator's native OSC protocol. No
OS daemons, no extra packages, no external binaries.

| Terminal | Protocol | Detection |
| --- | --- | --- |
| Ghostty | OSC 9 | `TERM_PROGRAM=ghostty` |
| iTerm2 | OSC 9 | `TERM_PROGRAM=iTerm.app` or `ITERM_SESSION_ID` |
| WezTerm | OSC 777 | default fallback |
| rxvt-unicode | OSC 777 | default fallback |
| Kitty | OSC 99 | `KITTY_WINDOW_ID` |
| Windows Terminal (WSL) | OSC 777 | `WT_SESSION` |

### Multiplexers (DCS passthrough)

OSC sequences are wrapped in DCS `ESC P tmux; … ESC \` so they survive
multiplexers (which would otherwise swallow the raw OSC bytes). Detected via:

| Multiplexer | Env |
| --- | --- |
| tmux | `TMUX` |
| Zellij | `ZELLIJ` or `ZELLIJ_SESSION_NAME` |
| GNU screen | `STY` |

### Unsupported terminals

Apple Terminal, Alacritty, and the native Windows console (outside WSL) do
not implement any OSC notification protocol. In those environments the
extension surfaces a TUI notice recommending an issue be filed, instead
of emitting a silent no-op.

## Why Unicode, not emoji

The upstream packages use `✅ ❌ 🔔` for status. That looks fine on macOS
with the system emoji font, but in:

- Linux distros without a Noto Color Emoji fallback
- SSH sessions with a stripped-down terminal font
- Windows Terminal in some configurations

those characters render as `?` boxes or width-doubled glyphs that break the
single-line layout. `\u2713` and `\u2717` are part of every monospace font
shipped with a serious terminal emulator since 2010, so we get a consistent
look everywhere without making the user install fonts.

## Requirements

- Node `>= 20`
- pi (latest)
- No API keys or external configuration

## Development

This package is part of the huangrx6/pi-plugin monorepo. From the repo root:

```bash
# Run the unit tests (covers formatBody, OSC bytes, multiplexer wrapping,
# terminal detection, extension factory).
cd extensions/pi-notify
npm install
npm test

# Type-check
npm run check

# Try it against a real pi session
pi -e ./extensions/pi-notify
```

## License

[MIT](./LICENSE)
