<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/skill-inject.svg" alt="skill-inject" width="48" />
</p>

# pi-skill-inject

<p align="center"><strong>Inline a skill's content into the current model turn.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

Type `/skill-name` anywhere in the prompt and the skill's `SKILL.md` is loaded and sent with the same turn — no extra round-trip, no manual `read` calls.

## What it does

The extension watches the `input` event, scans the prompt for `/<name>` tokens, resolves them to skill paths, and replaces the user-facing text with the skill's content via `before_agent_start`. The model receives the skill's full instructions on the first turn, so it can act on them without first asking for the file.

Key properties:

- **Zero monkey-patch** — uses only public events (`input`, `before_agent_start`, `tool_result`); no prototype changes
- **Strict token matching** — regex anchored to `[a-z0-9][a-z0-9-]*`; URLs, paths, and `skill:name` commands are not misinterpreted
- **No re-injection** — once a skill is loaded on the current branch, it is not sent again (state replays from `restoreLoadedSkills`)
- **Frontmatter-safe** — only line-initial `---` is recognized as a frontmatter delimiter, so `---` inside a description does not break parsing

## Usage

In a Pi prompt:

```text
let's /tdd this and /review when done
```

Both skills are loaded into the current turn's prompt; the model acts on them immediately. Press `<Tab>` after `/` (or after any prefix like `/t`) to autocomplete from the list of available skills.

Confirmation:

```bash
pi list             # confirm the package is registered
```

In a Pi session, `/loaded-skills` shows what has already been injected on the current branch.

## Token rules

| Input | Resolves to |
| --- | --- |
| `/skill-name` in prompt body | skill `skill-name` |
| `/SKILL-NAME` | exact-match first; case-insensitive fallback if no exact match |
| `/skill:name` | not treated as an inline skill (it's a Pi command) |
| `https://example.com/foo` | never treated as a token (regex boundary) |
| `/model` at prompt start | passes through; not intercepted as a skill |

## Deduplication

A skill is marked "already loaded" on the current branch when either:

- The extension injected it this turn, or
- The model called `read` on its `SKILL.md` (observed via `tool_result`).

Both events write a tombstone into the session branch, so reloading or resuming the session does not re-inject.

## Install

```bash
pi install git:github.com/huangrx6/pi-skill-inject
```

Or install the whole monorepo via `pi install git:github.com/huangrx6/pi-plugin`. Restart Pi or `/reload`.

For single-session testing without installation:

```bash
pi -e /path/to/pi-skill-inject
```

## Development

```bash
git clone https://github.com/huangrx6/pi-skill-inject.git
cd pi-skill-inject
# No npm install needed: imports of @earendil-works/* resolve to
# the running Pi install.
```

Edit `index.ts`, then reload via `/reload` or restart Pi to pick up changes.

## File structure

```text
pi-skill-inject/
├── index.ts          # single-file extension
├── package.json
├── README.md
└── LICENSE
```

## License

MIT © huangrx6
