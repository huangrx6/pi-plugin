<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/mode-switcher.svg" alt="mode-switcher" width="48" />
</p>

# pi-mode-switcher

<p align="center"><strong>Approval gate before every tool call.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

Intercepts Pi's `tool_call` event and decides — before the tool runs — whether to let it through, ask for confirmation, or block. The single permission layer for the entire tool-call chain.

It does not do task-flow routing, prompt injection, or session management. Those live in other extensions; this one only touches `tool_call`.

## Modes

| Mode | Command | Behavior | Use when |
| --- | --- | --- | --- |
| Ask | `/mode ask` | Every write / network / unknown tool pops a confirmation dialog | You want to see every step |
| Smart (default) | `/mode smart` | Only dangerous operations (`rm -rf`, `sudo`, `git push --force`, …) pop a dialog; the rest pass through | Daily development |
| Full | `/mode full` | Zero dialogs. Everything passes through. | High trust / automation |

Switch with `/mode ask`, `/mode smart`, or `/mode full`; or run `/mode` with no argument to get an interactive selector.

## Behavior matrix

| Tool call | ask | smart | full |
| --- | --- | --- | --- |
| `read` / `ls` / `grep` / `find` | auto | auto | auto |
| Read-only bash (`ls`, `cat`, `git status`) | auto | auto | auto |
| File writes (`write` / `edit` / `apply_patch`) | prompt | auto | auto |
| Network (`curl` / `wget` / `fetch_content` / `web_search`) | prompt | auto | auto |
| MCP tools / unknown tools | prompt | auto | auto |
| Write bash (`git push`, `rm`, `tee`, `mkdir`) | prompt | auto | auto |
| Dangerous bash (`rm -rf`, `sudo`, `mkfs`, `git push --force`) | prompt | prompt | auto |

`auto` = pass through. `prompt` = pop a confirmation dialog.

## How it works

```typescript
pi.on("tool_call", async (event, ctx) => {
  const reason = await checkPermission(currentMode, event.toolName, event.input, confirm);
  if (reason) return { block: true, reason };   // intercepted
  return undefined;                              // passed through
});
```

Decision chain (per tool call):

```text
read-only whitelist (read/ls/grep/find + read-only bash) → always auto
        ↓
mode === "full"   → all auto
        ↓
mode === "ask"    → read-only → auto; everything else → prompt
        ↓
mode === "smart"  → dangerous bash (rm -rf / sudo / …) → prompt; else → auto
```

The bash heuristic is a conservative regex set: writes (`rm`, `mv`, `cp`, `mkdir`, `chmod`, `sed -i`, redirect to non-`/dev/null`, git write, package manager, network commands), and dangerous (`rm -r/-f`, `sudo`, `mkfs`, `dd of=`, `git reset --hard`, `git push --force`). Compound commands (`&&`, `$(...)`, aliases) may be missed; missed cases default to "write" (the safer side). This is **not** AST parsing — it is a best-effort heuristic.

## Persistence

The active mode is written to `~/.pi/agent/mode-switcher.json` and restored on next launch. If a footer renderer is installed, the current mode appears in the status row.

## Install

```bash
pi install git:github.com/huangrx6/pi-mode-switcher
```

Restart Pi or `/reload`. Zero dependencies, zero configuration.

## File structure

```text
pi-mode-switcher/
├── index.ts          # single file: tool_call handler + checkPermission + bash heuristics
├── package.json
├── README.md
└── LICENSE
```

## License

MIT © huangrx6
