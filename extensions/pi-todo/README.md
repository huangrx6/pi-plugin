<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/todo.svg" alt="pi-todo" width="48" />
</p>

# pi-todo

<p align="center"><strong>Task-list tool plus an editor overlay. State replays from the session branch.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

A `todo` tool the model can call to maintain a checklist, plus a slim overlay above the editor that mirrors the live state. The entire state lives in the session branch — there is no separate store, no file on disk, and no `~/.pi` cache. `/reload` and Pi's built-in compaction both preserve the list.

Zero runtime dependencies. The only Pi import is `import type`; tool parameter schemas are hand-written JSON Schema literals (Pi's built-in tools use TypeBox, which is also JSON Schema under the hood).

## Display

Collapsed overlay (default — up to 12 task rows):

```text
┌────────────────────────────────────────────────┐
│  (chat area)                                   │
├────────────────────────────────────────────────┤
│  ● Todos (1/3)                                 │  ← overlay
│  ├─ ◐ #2 写测试 (writing tests)                │
│  ├─ ○ #3 部署验证 ⛓#1,#2                       │
│  └─ +2 more (2 completed) · /todos expand      │
│  > type here...                                │  ← editor
└────────────────────────────────────────────────┘
```

`/todos expand` removes the 12-row cap and renders everything:

```text
● Todos (15/20)
├─ ◐ #2 写测试 (writing tests)
├─ ○ #3 部署验证 ⛓#1,#2
├─ ○ #4 ...
...
└─ /todos collapse
```

- **Overlay** — in-progress ◐ is highlighted; pending ○ is dim; completed ✓ is dropped first, folded into `+N more`; dependency links (`⛓`) only show `#id` numbers when a real `blockedBy` exists; > 12 rows → auto-collapse with a `/todos expand` hint; empty list → overlay hides
- **`/todos`** — prints the current list grouped by status
- **`/todos expand`** — show every task; per-session UI preference, never written into the branch
- **`/todos collapse`** — back to the 12-row budget
- **`/todos status`** — reports the current fold / expand state

## Tool schema

```json
todo { "action": "create",   "subject": "调研现有工具" }
todo { "action": "update",   "id": 3, "status": "in_progress", "activeForm": "writing tests" }
todo { "action": "delete",   "id": 2 }            // tombstone — never reusable
todo { "action": "list",     "status": "pending" }
todo { "action": "clear" }
```

State machine: `pending → in_progress → completed → deleted` (`deleted` is terminal).

## Semantic guarantees

| Guarantee | Why |
| --- | --- |
| **IDs never reuse** | `clear` empties the list but `nextId` only increments. Stale "#N" references in the conversation always stay dead. |
| **Tombstones immutable** | Any `update` on a deleted task — including subject / metadata changes — is rejected. |
| **Dependencies healthy** | Dangling `blockedBy`, deleted dependencies, self-blocks, and cycles are all rejected with specific error messages. |
| **No-op detection** | A duplicate `update` with identical fields returns "No change" (metadata key order is insensitive) — prevents model retry loops. |
| **Terminal-safe text** | Model-controlled strings are scrubbed for CSI / OSC / newlines / bidi controls before rendering. |
| **Per-session isolation** | State is keyed by `sessionId`; sub-sessions and branches do not pollute each other. |
| **Follows foreground** | The overlay always shows the latest UI-bearing session — switching sessions switches the list. |
| **Zero render-time I/O** | Row budget is constant; no config files are read during render. |
| **Expand state independent of branch** | `/todos expand` lives in a foreground UI slot, not in branch details — `/reload` resets it by design. |

## Persistence

```text
todo call → details carries {tasks, nextId} snapshot → appended to branch
session_start / compact / tree → replay the latest valid snapshot from branch
```

Pi's session is append-only and built-in compaction does not remove branch entries, so the most recent snapshot is always recoverable.

## Coexistence

Tool name `todo` is the persistence key — branch entries are filtered by `toolName === "todo"`. If you install another extension that also registers a `todo` tool, the two will conflict; pick one.

## Install

```bash
pi install git:github.com/huangrx6/pi-todo
```

Or via the monorepo. Restart Pi or `/reload`.

## Known limitations

- Row budget is fixed at 12 (default fold); expanded view has no cap (user-controlled; deliberate — avoid config-file reads during render)
- Expand state is per-session UI preference, never persisted to branch — `/reload` and compaction reset to fold (the user re-runs `/todos expand`)
- Overlay chrome is not localised (English)

## File structure

```text
pi-todo/
├── index.ts          # tool + command registration + event wiring
├── types.ts          # domain types + JSON Schema
├── reducer.ts        # pure reducer: state machine / cycle detection / no-op detection
├── store.ts          # session-keyed slots + foreground pointer + branch replay
├── format.ts         # three-view formatting + terminal scrubbing + width calc
├── overlay.ts        # setWidget overlay
├── globals.d.ts      # ambient shim for the Pi runtime types
├── tsconfig.json     # local type-check
├── package.json
├── README.md
└── LICENSE
```

## License

MIT © huangrx6
