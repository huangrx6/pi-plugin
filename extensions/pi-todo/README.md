<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/todo.svg" alt="pi-todo" width="48" />
</p>

# pi-todo

<p align="center"><strong>Workspace-scoped durable todo tool for Pi with a live editor overlay and a workflow-recovery command.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
  <img alt="version" src="https://img.shields.io/badge/version-0.5.1-2ea44f?style=flat-square" />
</p>

A `todo` tool the model can call, a `/todos` command for the user, and a slim overlay above the editor. State is owned by a per-workspace **durable envelope** stored on disk; the session branch is no longer the authority. Pi `/reload` and built-in compaction both preserve the list (the workspace is the identity, not the session).

Zero runtime dependencies. The only Pi import is `import type`; tool parameter schemas are hand-written JSON Schema literals.

```text
pi-todo 0.4.2

P0-P3  Kernel                       CLOSED / FROZEN
       └── P1-D Test Amendment T1   RE-FROZEN

P4     Pi-native Personal UX        CLOSED / FROZEN
├── P4-A Friction Audit             CLOSED
├── P4-B UX Prioritization          CLOSED
├── P4-C1 Core Daily UX             CLOSED / FROZEN
├── P4-C2 Workflow Convenience      CLOSED / FROZEN
└── P4-D Real-use Polish            CLOSED / FROZEN
```

## What it does

| Surface | When | What |
| --- | --- | --- |
| `todo` tool | Model | create / update / delete / list / clear tasks atomically. |
| `/todos` | User | Command panel: pick any action from an annotated list (no memorizing). |
| `/todos ready` / `blocked` / `completed` / `archived` | User | Section drill-downs — full lists, no budget. |
| `/todos all` | User | Full historical state including archived. |
| `/todos next` | User | Explicit "what is ready right now" answer (complete READY list). |
| `/todos <id>` | User | Rich detail: canonical row + description + blockers + direct unlocks. |
| `/todos here` | User | Workflow recovery — current running task + completion consequences. |
| overlay | Always | Live ambient view of the current workspace above the editor. |
| `session_start` | Pi boot / `/reload` | Silent best-effort cold-bootstrap of the overlay (no branch replay). |

## Display

### Overlay (always on above the editor)

```text
┌────────────────────────────────────────────────┐
│  (chat area)                                   │
├────────────────────────────────────────────────┤
│  Todos · ▶1 ◆2 ○1                              │  ← overlay
│  ▶ #11 Write P4-D friction audit               │
│  ◆ #12 Walk 6 paths in real use                │
│  ◆ #13 Triage findings into HIGH/MEDIUM/LOW    │
│  ○ #14 Fix any HIGH before v1 closure ← #12   │
├────────────────────────────────────────────────┤
│  > type here...                                │  ← editor
└────────────────────────────────────────────────┘
```text

- Header `Todos · ▶N ◆M ○K` — sections whose count is 0 are omitted.
- In-progress `▶` runs first, then `◆` ready, then `○` blocked; completed `✓` is dropped first, folded into the per-section `+N more` overflow.
- Dependency links (`← #id`) only appear when a real `blockedBy` exists; `?` marks a missing dependency.
- Empty state (no active, no visible completed) → overlay hidden.
- Hidden on cold start until first successful durable load.

### `/todos` (command panel)

No arguments opens an interactive two-level panel. Every row carries a Chinese explanation — the panel doubles as living documentation:

```text
┌ Todos — 选择操作 ─────────────────────────┐
│ here    — 我现在在做什么（当前任务 + 完成后会解锁什么）│
│ finish  — 完成任务（从进行中的任务里选）        │
│ start   — 开始任务（从可开始的任务里选）        │
│ next    — 现在可以开始哪些任务              │
│ 总览    — 全部任务概览（进行中 / 可开始 / 被阻塞）│
│ 详情    — 查看某个任务（说明 / 依赖 / 解锁）    │
│ …      — why / unlocks / archive / restore … │
└──────────────────────────────────────┘
```

- **Level 2**: action rows offer a task picker (canonical task rows,
  role icons) built from one durable snapshot; `archive` / `restore`
  prepend batch rows equivalent to `archive completed` / `restore
  archived`.
- **总览** renders the bounded overview below (per-section budget
  2 / 3 / 2 with `+N more <role>` drill-down hints; section commands
  remain full lists).
- Direct verbs (`/todos next`, `/todos finish 17`, `/todos 17`) bypass
  the panel and keep working unchanged.
- Headless runtimes (no `ui.select`) get the catalog as plain text.

```text
RUNNING
▶ #11 in-progress one

READY
◆ #20 ready task number 20
◆ #21 ready task number 21
◆ #22 ready task number 22
  +15 more ready

BLOCKED
○ #50 blocked one
○ #51 blocked two

✓ 6 completed · /todos completed
```

### `/todos here` (workflow recovery)

```text
Current:
▶ #11 Write P4-D friction audit

Completing this task would make ready:
  ◆ #21 Triage findings
```text

- `RUNNING = 0` → `No task is currently running.` (with verbatim frozen `Next:` section if ready exist).
- `RUNNING = 1` → `Current:` + canonical row + direct unlocks.
- `RUNNING > 1` → `Current: N running` + indented per-task sections.
- `here 17` / `HERE` → syntax error (zero-arg verb; LOCK 23).

### `/todos <id>` (rich detail)

```text
▶ #17 Implement cache bootstrap
Already running.

Restore the workspace todo overlay from durable state after /reload.

Completing this task would make ready:
  ◆ #21 Integration tests
```

- Canonical row + frozen `formatWhyTask` body (Ready to start. / Already running. / Blocked by: / Completed. / Archived.).
- `Task.description` is surfaced when present (presentation-only data; LOCK 28).
- Direct unlocks for `ready` / `running` / `blocked` only; `completed` / `archived` have no completion consequence.
- No `Required by:` / reverse-dependency section (LOCK 19). No second `Status:` / `State:` vocabulary (LOCK 20). No raw metadata / owner / timestamps (LOCK 28).

## Mutation

`/todos` verbs that change state are all-or-nothing — if any target fails its precondition, no target is changed.

- `/todos start <id>` · `/todos finish <id>` · `/todos reopen <id>`
- `/todos archive <id> [<id> …]` · `/todos archive completed`
- `/todos restore <id> [<id> …]` · `/todos restore archived`

When a mutation changes downstream readiness, the response may include a `Now ready` or `Re-blocked` section.

The following selector combinations are intentionally unsupported (P1-A policy, frozen):

| Verb | Selector |
| --- | --- |
| `archive` | `all` |
| `archive` | `archived` |
| `restore` | `all` |
| `restore` | `completed` |

The error message now explains *why* the selector is rejected (P4-C2 wording polish), e.g.:

```text
`all` cannot be used with `archive` because already-archived tasks
are outside the archive target set.

Use task IDs or `completed`.
```text

The policy itself (which selectors are accepted) is frozen. Only the explanation text changed (P4-C2 LOCK 21).

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
| **Workspace identity ≠ session identity** | State is keyed by `canonical realpath(ctx.cwd)` (SHA-256 → `workspace:v1:<digest>`). Switching sessions on the same workspace keeps the same list. `/reload` restores the overlay silently via the cold-bootstrap path. |
| **Branch history ≠ workspace state** | `replayFromBranch` is RETIRED from the lifecycle. The overlay never reads from `session_start` / `compact` / `tree` events. Workspace todo state lives in the durable envelope, not in branch entries. |
| **One durable snapshot per command** | Each `/todos` invocation does exactly one `durableStore.load` + one `durableStore.commit` (on success). Canonical command reads own their snapshot — they do NOT consume `OverlaySnapshotCache` as semantic input. |
| **Replay evidence ≠ current state authority** | `ReplayMutationMaterial` is reconstruction evidence, never a state source. CAS-conflict discards the provisional material; only successful commits promote it. |
| **Empty no-op ≠ fake revision** | When `archive` resolves to an empty target set, the formatter emits `Nothing to archive.` and the revision does NOT advance. |
| **CAS conflict ≠ transparent retry** | On revision mismatch, the formatted success text is discarded and a `cas-conflict` error notice is emitted — the caller decides whether to retry. |
| **Atomic publish ≠ cross-process CAS** | Each command is its own single-writer CAS. There is no cross-process coordination; concurrent writers race and the loser sees a conflict. |
| **Overlay cache ≠ semantic authority** | `OverlaySnapshotCache` is presentation projection only. It is updated only after a successful durable load / commit. It MUST NOT be read as semantic input by any canonical command. |
| **Format before CAS, emit after CAS** | Success text is formatted against the post-execution state BEFORE the durable commit. If CAS reports conflict, the formatted text and the provisional material are both discarded. |
| **Zero render-time I/O** | Row budget is constant; no config files are read during render. |
| **P4 formatters do not structurally decompose frozen formatter output** | (LOCK D3) Composition is typed-result based. `formatUnlocksTask(...).slice(2)` is not allowed; the same presentation is built from `UnlocksTaskResult` via `formatDirectUnlockConsequences`. |

## Persistence

State is a `CurrentPersistedTodoEnvelope`:

```text
{
  schemaVersion: 1,
  revision: 17,        // monotonic; CAS expected-revision
  state: { tasks: [...], nextId: 1000 }
}
```text

- **Default root**: `<getAgentDir()>/pi-todo/<filename>` where `<filename> = sha256(workspace:v1:canonical_realpath(cwd))`.
- **CAS commit**: `durableStore.commit(scope, expectedRevision, next)`. Mismatch → `cas-conflict` error; formatted text and provisional replay material are both discarded.
- **Replay evidence**: `ReplayMutationMaterial { baseRevision, revision, actions, replayContext: { nowValues } }`. Captured before CAS, isolated via `structuredClone`. Available for reconstruction; not a state source.
- **Workspace scope resolution**: `createWorkspaceScopeKeyResolver()` maps `(ctx.cwd, ctx.sessionManager) → canonical realpath → SHA-256 → "workspace:v1:<digest>"`.
- **Cold start**: `session_start` (including Pi's `reason: "reload"`) does a silent best-effort durable load and populates the overlay cache. Failures are silent — overlay stays `[]` and Pi startup continues.

## Coexistence

Tool name `todo` is the persistence key. If you install another extension that also registers a `todo` tool, the two will conflict; pick one.

## Install

```bash
pi install git:github.com/huangrx6/pi-plugin
```

Or via the monorepo. Restart Pi or `/reload`.

## Known limitations

- Row budget is fixed at the same per-section value for both `/todos` and the overlay (2 / 3 / 2 by default). There is no per-terminal-width adaptation yet (deferred — the Pi extension command/UI contract does not currently expose terminal width; see the design notes in CHANGELOG 0.4.1).
- Workspace todo state is per-canonical-realpath. Renaming or moving a workspace directory creates a fresh state — by design (location = identity).
- The overlay chrome and wording are English-only.
- `/todos here` requires a single `RUNNING` task to show `Current:`; with `RUNNING > 1` it shows the full multi-section view (no "anomaly" claim).
- The `Task.description` field is rendered in `/todos <id>` only when present. The model-side `activeForm` is prompt-only (not CLI-visible).

## File structure

```text
pi-todo/
├── index.ts                    # tool + /todos + lifecycle wiring
├── types.ts                    # domain types + JSON Schema
├── reducer.ts                  # pure state machine
├── store.ts                    # legacy session-keyed slots (test surface only; 0 production callers)
│
├── format.ts                   # canonical row + snapshot formatters (P0-B B2)
├── graph-format.ts             # next / why / unlocks formatters (P2-B, frozen)
├── overview-format.ts          # P4-C1 bounded overview formatter
├── task-detail-format.ts       # P4-C2 rich /todos <id> formatter
├── current-task-format.ts      # P4-C2 /todos here formatter
├── direct-unlock-format.ts     # P4-D typed-result composition (LOCK D3)
├── mutation-format.ts          # P1-C error wording (frozen)
├── workflow-format.ts          # P4-C2 workflow syntax wording
├── selector-policy-notice.ts    # P4-C2 selector rejection wording
│
├── parse-todos-command.ts       # P0-B B3 read grammar
├── parseMutationCommand       (in mutation-command.ts)
├── parseGraphCommand          (in graph-command.ts)
├── workflow-command.ts          # P4-C2 additive P4 grammar (here)
│
├── query layer (P2-A) — frozen
├── graph-query.ts               # queryNextTasks / queryWhyTask / queryUnlocksTask
├── graph.ts                     # reverseDependencies / brokenDependencies
├── projection.ts                # projectActiveView / projectCompleted / projectArchived
├── read-model.ts                # buildDependencyPresentation
│
├── persistence layer (P3) — frozen
├── persistence-contract.ts      # ScopeKey, ScopeKeyResolver, ReplayMutationMaterial, ReplayContextSession
├── persistence-error.ts         # PersistenceError union
├── persistence-codec.ts         # structural validation of serialized Task shape
├── persistence-migration.ts     # schema migrations (v0 identity → v1)
├── persistence-format.ts        # infrastructure notice vocabulary
├── durable-store.ts             # DurableTodoStore interface + InMemoryDurableTodoStore
├── file-durable-store.ts        # real backend (SHA-256 scope → filename, atomic publish)
├── workspace-scope.ts           # canonical realpath → ScopeKey
│
├── replay layer (P3-D) — frozen
├── replay-context.ts            # ReplayContextAdapter (A2 shape)
├── replay-engine.ts             # replayMutationMaterial / replayMutationChain
├── replay-capture.ts            # createObservedReduceContext (snapshot-isolated nowValues)
│
├── presentation layer (P3-E) — frozen authority
├── overlay.ts                   # setWidget overlay (scope-keyed presentation)
├── overlay-snapshot-cache.ts    # ScopeKey-keyed presentation cache
├── runtime-persistence.ts        # production factory wiring (getAgentDir / file backend)
│
├── test-harness.ts              # ExtensionAPI stub + lifecycle capture + widget spy
├── globals.d.ts                 # ambient shim for the Pi runtime types
├── tsconfig.json
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```text

## License

MIT © huangrx6
