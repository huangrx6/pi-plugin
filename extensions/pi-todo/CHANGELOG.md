# Changelog

## 0.5.0

### v1.1: `/todos` command panel (no-args entry)

`/todos` with no arguments now opens an interactive two-level command
panel instead of the default view. Every row carries a Chinese
explanation, so the panel doubles as living documentation — nothing
has to be memorized. Direct verbs (`/todos next`, `/todos finish 17`,
`/todos 17`, …) keep working unchanged; the panel is a discovery
entry, not a replacement.

- **Level 1 — action catalog** (16 rows, frequency-ordered):
  `here / finish / start / next / 总览 / 详情 / why / unlocks /
  archive / reopen / restore / all / ready / blocked / completed /
  archived`, each as `命令 — 中文说明`.
- **Level 2 — task picker**: action rows offer a second picker of
  concrete tasks (canonical `formatTaskRow` rows, role icons intact)
  populated from one durable snapshot. `archive` / `restore` prepend
  a batch row equivalent to the frozen `archive completed` /
  `restore archived` selectors. Empty lists surface a plain notice
  (`没有进行中的任务`) instead of an empty picker.
- **Authority boundary**: the panel only composes commands. Every
  picked action re-dispatches through the frozen paths
  (`runMutationFlow` / `runGraphQuery` / `runWorkflowQuery` /
  `runReadCommand`), each owning its own durable snapshot. The
  overview is still reachable via the `总览` row ("" maps to the
  default bounded view — no recursion: the read path never re-enters
  the menu).
- **Headless fallback**: when `ctx.ui.select` is unavailable (rpc /
  json runtimes), the panel degrades to a plain text catalog.
- **No grammar change**: no new verbs were added. Empty args route to
  the panel inside the handler; `parse-todos-command.ts` and every
  other frozen parser are untouched.

### Test Amendment T2 (controlled, auditable)

The no-args behavior change (overview → panel) required updating the
invocation path of tests that call the handler with `""` expecting
the default view. Semantic assertions are unchanged — each test now
stubs the level-1 picker to pick the `总览` row first:

```
files:    index.test.ts (6 call sites), mutation-wiring.test.ts (1)
change:   helper functions stub ui.select → "总览 — …" when invoking
          with empty args
reason:   v1.1 panel entry on /todos no-args

semantic effect:
  - default bounded overview output unchanged
  - all read/mutation/graph semantics unchanged
  - assertions on rendered output unchanged

v1 test evidence RE-FROZEN after T2.
```

### Files

- **New**: `menu-panel.ts` (catalog + task rows + fallback),
  `menu-panel.test.ts` (19 tests).
- **Updated**: `index.ts` (B3 tail extracted into `runReadCommand`;
  `runMenu` / `runMenuImmediate` wiring; empty-args → panel),
  `test-harness.ts` (swappable `ui.select` stub + reset),
  `index.test.ts` (+7 panel integration tests, T2 amendments),
  `mutation-wiring.test.ts` (T2 amendment), `package.json` (0.5.0,
  menu-panel.test.ts in test script).

### Tests

861 tests / 0 fail (842 via old script + 19 menu-panel; final count
after adding menu-panel.test.ts to the script). tsc clean. P0–P3
frozen modules untouched.

## 0.4.2

### P4-D Terminal fix: `.slice(2)` retirement (LOCK D3)

The P4-D v1 fix for the duplicate canonical task row used
`formatUnlocksTask(...).slice(2)` to drop the frozen formatter's
internal `head` line. This made P4 composition depend on the
frozen P2-B formatter's internal text layout — a structural
coupling that no TypeScript check, domain test, or authority test
could catch if P2-B's output shape ever changed.

Per LOCK D3 — "P4 formatters MUST NOT structurally parse, slice,
index, regex-match, or otherwise decompose `string[]` returned by
frozen P0-P3 formatters" — the v1 fix is replaced with a
typed-result composition:

- **New module**: `direct-unlock-format.ts` exports
  `formatDirectUnlockConsequences(result, width)`. Consumes the
  frozen `UnlocksTaskResult` discriminated union (P2-A) and
  re-renders via the public P0-B `formatTaskRow` primitive. No
  `formatUnlocksTask` is called; no formatter `string[]` is
  decomposed.
- **`task-detail-format.ts` updated**: replaced
  `formatUnlocksTask(...).slice(2)` with
  `formatDirectUnlockConsequences(unlocks, width)`. The duplicate
  canonical task row is still avoided (same user-visible output as
  v1 fix); the structural coupling is gone.
- **Architecture test added (LOCK D3)** in
  `task-detail-format.test.ts`: source inspection asserts that
  `task-detail-format.ts` does NOT contain `.slice(` / `.splice(` /
  `.findIndex(`, does NOT import `formatUnlocksTask`, and DOES
  import from `./direct-unlock-format.ts`. Makes the
  "frozen formatter output is terminal, not an AST" contract
  machine-verifiable.

P4-D HIGH friction tally: found 1, resolved 1, **HIGH = 0**.

### P1-D Test Amendment T1 (controlled, auditable)

**mutation-wiring.test.ts Row 8** was modified during the P4-C2
implementation. Row 8 is part of the **P1-D frozen contract evidence**
(test-boundary verification of the mutation-wiring C4–C10 invariants).
Per the freeze audit rule (analogous to P3-A Amendments A1 / A2),
this is recorded as a controlled, intentional amendment:

```
P1-D TEST AMENDMENT T1

file:       mutation-wiring.test.ts
section:    Row 8 (selector policy failure case)
change:     expected wording updated from
            "`all` is not a valid selector for `archive`"
            to
            "`all` cannot be used with `archive`"
reason:     P4-C2 LOCK 21 — selector-policy rejection wording
            intentionally moved to formatSelectorPolicyNotice
            (additive P4 module). The frozen validator
            (validateMutationCommand) is unchanged.

Semantic effect:
  - selector policy unchanged
  - acceptance / rejection set unchanged
  - mutation execution semantics unchanged
  - commit semantics unchanged
  - only selector-policy UX wording changed

P1-D semantic contract remains FROZEN.
P1-D test evidence is RE-FROZEN after T1.
```

**No other P0–P3 frozen module (source or test) was modified for
P4-C2.** Verified via the per-file mtime check in the P4-C2
closure report: all 25 frozen P0–P3 modules retain their P3-E
closure mtimes.

---

## 0.4.2

P4-C2 workflow convenience. Three additive P4 commands / UX improvements
on top of the P3-E kernel. No frozen P0–P3 module was modified — P4-C2
lives entirely in additive P4 modules and a thin index.ts wiring layer.

### `/todos here` (P4-C2.a)

Workflow-recovery view: shows the current running task(s) + their
direct completion consequences. Accepts exactly zero arguments; extra
tokens are a syntax error (never silently dropped). Case variants
(`HERE`, `Here`) are also syntax errors per P2-C precedent.

- **Architecture**: an additive P4 `workflow-command.ts` grammar layer.
  `parse-todos-command.ts` (P3-E frozen) is **NOT modified** — the
  `here` token is NOT a B3 verb. The dispatch order in `index.ts` is
  P1 mutation → P2 graph → **P4 workflow** → B3 fallthrough.
- **Layer chain**: `projection (P0-B) → queryNextTasks /
  queryUnlocksTask (P2-A) → formatNextTasks / formatUnlocksTask /
  formatTaskRow (P2-B / P0-B) → current-task-format (P4-C2)`. No
  re-implementation of any dependency / readiness / lifecycle semantic.
- **RUNNING vs BLOCKED are mutually exclusive** (P2-B role model).
  RUNNING task outputs never include a `Blocked by:` section. RUNNING
  outputs only show the running task + direct unlocks.
- **RUNNING=0 "Next:" summary** is the frozen `formatNextTasks` output
  embedded verbatim — no double section header.
- **Read-only**: no mutation, no branch rewind, exactly one durable
  snapshot per invocation.

### Rich `/todos <id>` (P4-C2.b)

Composition: frozen `formatWhyTask` (P2-B) is the canonical semantic
body; P4-C2 decorates it with `Task.description` and direct-unlock
presentation only.

- **Classification authority**: `queryWhyTask` (P2-A) is the sole
  authority for `not-found / deleted / archived / completed / ready /
  running / blocked`. Raw `Task` lookup is permitted **only** to read
  `.id` and `.description` (LOCK 28). Lifecycle / readiness /
  dependency decisions are NOT re-implemented in P4.
- **No "Required by:"** — reverse-dependency inspection is out of
  scope (LOCK 19).
- **No second Status/State vocabulary** — the canonical task row
  (with role glyph) is the user's role/lifecycle representation
  (LOCK 20).
- **No raw metadata / owner / archiveAt / revision / timestamps** in
  the CLI output (LOCK 28).

### Selector rejection wording (P4-C2.c)

The frozen `validateMutationCommand` (P1-A) policy is **unchanged**;
`archive all` and `restore all` are still rejected. Only the
user-visible explanation is upgraded to actionable text. Wording is
owned by the additive P4 `selector-policy-notice.ts` module.

- **Architecture direction**: `mutation-selector.ts (validation) →
  formatSelectorPolicyNotice (presentation)`. The reverse direction
  is forbidden — `mutation-selector.ts` MUST NOT import the P4
  module (verified by source-inspection test).
- **Consumes narrow `MutationUsageError`** only. Does NOT import
  broader `MutationError` / `MutationCliError` unions (LOCK 21).
- **All other P1 error kinds** (command-syntax / selector-syntax /
  resolution / domain) still use frozen `formatMutationError`.

### Files

- **New modules**:
  - `workflow-command.ts` — 3-state additive P4 grammar for `here`.
  - `workflow-format.ts` — workflow syntax-error wording (LOCK 30).
  - `current-task-format.ts` — `/todos here` formatter.
  - `task-detail-format.ts` — rich `/todos <id>` formatter.
  - `selector-policy-notice.ts` — selector rejection wording.
- **New test files** (52 new tests):
  - `workflow-command.test.ts` (13 tests)
  - `workflow-format.test.ts` (1 test)
  - `current-task-format.test.ts` (9 tests)
  - `task-detail-format.test.ts` (16 tests)
  - `selector-policy-notice.test.ts` (13 tests)
- **Wiring** (additive, no frozen module modified):
  - `index.ts` — added `parseWorkflowCommand` / `formatCurrentTask` /
    `formatTaskDetailRich` / `formatSelectorPolicyNotice` /
    `parseWorkflowCommand` / `formatWorkflowSyntaxError` imports;
    added `runWorkflowQuery` (mirrors `runGraphQuery` one-snapshot
    pattern); replaced `renderDetail` body with
    `formatTaskDetailRich`; replaced `selector-policy` error site
    with `formatSelectorPolicyNotice`.
  - `index.test.ts` — added 23 P4-C2 integration tests; updated 6
    existing `/todos <id>` tests to expect the new
    `formatWhyTask`-based output (P2-B role model); removed
    `Required by:` assertion (out of scope per LOCK 19).
  - `mutation-wiring.test.ts` — P1-D Row 8 selector policy test
    updated to assert the new actionable wording.
- **Updated**: `package.json` (version 0.4.1 → 0.4.2; 5 new test
  files in `test` script).

### Tests

763 tests pass (up from 738 at P4-C1 closure). All P0–P3 contracts
preserved exactly. Frozen module mtime drift: only `index.ts` and
`test-harness.ts` are modified; all 25 frozen P0–P3 modules retain
their P3-E closure mtimes.

### Status

- `pi-todo 0.4.2` — P4-C2 Workflow Convenience **CLOSED**
- P4-B UX Prioritization **CLOSED**
- P4-A Friction Audit **CLOSED**
- P4-C1 Core Daily UX **CLOSED / FROZEN**

## 0.4.1

P4-C1 core daily UX. Two presentation-layer improvements; no frozen
semantic contract is modified (P0–P3 contracts preserved exactly).

### Cold-start workspace bootstrap

On `session_start` (including `/reload` per Pi `SessionStartEvent.reason`),
the extension performs a silent, best-effort durable load of the current
workspace and populates the `OverlaySnapshotCache`. The overlay
immediately restores the workspace's current state on Pi startup
without requiring the user to invoke `/todos` first.

- **Lifecycle read, NOT mutation**. Resolves scope, loads the envelope,
  populates the cache, and refreshes the overlay widget. Zero
  `ctx.ui.notify`. Zero `commitState` / `replaceState` /
  `replayFromBranch`. Zero branch restoration.
- **Failure policy is best-effort**. `clearActiveScope()` runs FIRST so
  a previous session's stale scope cannot drive the overlay if this
  session's load fails. Scope resolution failure OR load failure →
  overlay `[]`, session startup continues, no notification. The cache
  may retain the previous envelope, but presentation identity requires
  `activeScope !== undefined`, so the overlay correctly reads
  `EMPTY_STATE`.
- **Authority boundary preserved**. Bootstrap populates the
  presentation cache only. Canonical command reads (`/todos`,
  `/todos ready`, etc.) still perform their own durable load — they
  do NOT consume `OverlaySnapshotCache` as semantic input. Verified
  via integration test: after bootstrap, `/todos ready` triggers
  exactly one additional load and observes the latest committed
  state (proving no cache-state reuse).

### Bounded default `/todos` overview

The default `/todos` command renders a bounded overview with per-section
budgets and explicit "+N more &lt;role&gt;" drill-down hints. Section
commands (`/todos ready`, `/todos blocked`, `/todos completed`,
`/todos archived`) remain full-list drill-downs via the frozen
`formatTasksList`.

- **Frozen `format.ts` untouched**. New module `overview-format.ts`
  composes the frozen `formatTaskRow` primitive and the frozen
  `ActiveView` projection — no primitive re-implementation.
- **Defaults**: `RUNNING ≤ 2`, `READY ≤ 3`, `BLOCKED ≤ 2`. Caller can
  override per-budget via `options.budgets`.
- **Completed-only oracle**: when `active = 0` and
  `completedVisible > 0`, the bounded formatter output is exactly
  identical to the frozen `formatTodosSnapshot` output (oracle-tested
  via `assert.deepEqual`). P0-B completed-summary semantics preserved.
- **Empty / archived-only**: `formatBoundedOverview` returns `[]`
  (matching frozen formatter); `renderDefault` in `index.ts` translates
  that into the user-visible `"No todos."`.
- **Drill-down hints are unambiguous**: `+N more &lt;role&gt;` (CLI)
  vs `+N &lt;role&gt;` (overlay) — distinct wording so readers know
  the CLI hint is a drill-down prompt, not just a section count.

### Files

- **New**: `overview-format.ts`, `overview-format.test.ts` (13 tests).
- **Updated**: `index.ts` (`clearActiveScope()`-first bootstrap in
  `session_start`, `renderDefault` swapped to `formatBoundedOverview`),
  `test-harness.ts` (lifecycle handler capture + widget-call spy),
  `index.test.ts` (11 P4-C1 integration tests).

### Tests

738 tests pass (up from 727 at P3-E closure). All P0–P3-D contracts
preserved exactly. Zero store.ts production callers. P4-C1 introduces
no new command verbs, no new grammar, and no new frozen-contract
modifications.

## 0.4.0

P3-E production integration. Durable state authority now lives in
`CurrentPersistedTodoEnvelope` loaded through the P3-B backend; legacy
session-local `Map<sessionId, TaskState>` is no longer read by any
production path.

- **State authority migration**: every command resolves a `ScopeKey`
  (workspace canonical path → SHA-256 digest), loads the envelope
  exactly once, and applies mutations through CAS commit. Branch
  history no longer drives task state.
- **`replayFromBranch` retired** from the lifecycle hook
  (`session_start` / `compact` / `tree` / `shutdown`). The overlay
  refresh is best-effort and reads from the `OverlaySnapshotCache`
  (ScopeKey-keyed presentation only), not from branch events.
- **Format-before-CAS ordering**: success text is formatted against
  the post-execution state BEFORE the durable commit. If CAS reports
  conflict, the formatted text and the provisional `ReplayMutationMaterial`
  are both discarded — only successful commits emit UX.
- **Empty semantic no-op short-circuits** before any reducer time
  observation, replay capture, or CAS. `Nothing to archive.` /
  `Nothing to restore.` is emitted as a normal `info` notice with
  zero revision delta.
- **Replay evidence isolation**: `ReplayMutationMaterial` snapshots
  are `structuredClone` copies — neither the plan actions nor the
  observed `nowValues` share references with the live reducer state.
- **Factory options**: `factory(pi, { persistence })` accepts a
  `TodoRuntimePersistence` override. Tests inject an
  `InMemoryDurableTodoStore`; production wires the file backend at
  `getAgentDir() / "pi-todo"`.
- **`store.ts` zero production callers**: index.ts no longer imports
  `getState` / `commitState` / `replaceState` / `replayFromBranch`.
  The file remains in the package for legacy callers and tests.
- **New modules**:
  - `parse-todos-command.ts` — P0-B B3 read grammar (default / detail
    id / ready / blocked / completed / archived / all / unknown).
  - `overlay-snapshot-cache.ts` — ScopeKey-keyed presentation cache.
  - `runtime-persistence.ts` — production factory wiring file
    backend at `getAgentDir() / "pi-todo"`.
  - `replay-capture.ts` — `createObservedReduceContext` factory
    (snapshot isolated nowValues).
  - `persistence-format.ts` — 6-layer infrastructure notice vocabulary.
- **Tests**: 721 tests pass (up from 695 at P3-D). All P0–P3-D
  contracts preserved.

## 0.3.0

Mutation UX. The `/todos` command can now change task state.

- **Lifecycle**: `/todos start <id>`, `/todos finish <id>`,
  `/todos reopen <id>`.
- **Batch archive / restore**: `/todos archive <ids...>`,
  `/todos archive completed`, `/todos restore <ids...>`,
  `/todos restore archived`.
- **Atomicity**: multi-task commands are all-or-nothing — if any
  target fails its precondition, no target is changed.
- **Dependency feedback**: when a mutation makes a downstream task
  ready or blocked, the response includes a `Now ready` or
  `Re-blocked` section listing those tasks.
- **Read UX unchanged**: `/todos`, `/todos <id>`, `/todos ready`,
  `/todos blocked`, `/todos completed`, `/todos archived`,
  `/todos all`, `/todos expand`, `/todos collapse`, `/todos status`
  all keep their previous behavior.
- **Tool schema unchanged**: `create` / `update` / `delete` / `list`
  / `clear` actions are unchanged.

## 0.2.2

- Fix the "model plans in plain text instead of calling the tool" failure mode. The prompt guidance was all status discipline (when to mark in_progress/completed) with only a soft self-judged trigger ("complex work with 3+ steps") — so when the user explicitly asked for a plan/task breakdown, the model's default plain-text listing was never interrupted. All three guidance layers now lead with the explicit trigger: when the user asks to plan / break down work / make a todo list (制定任务, 列个计划, 拆解一下, create a plan, …), ALWAYS create todo items via the tool; presenting the plan as plain text is named as a failure mode. The 3+ steps heuristic and single-trivial-task exemption are kept.

## 0.2.1

Sharper prompt text to fix the "completed task stays in_progress" pattern.

- **`promptSnippet`**: switched from passive "Manage a task list…" to
  directive "Track multi-step work via `todo`. Mark each task
  in_progress BEFORE starting it and completed the moment its success
  criterion holds — do not batch, do not defer, do not leave tasks
  open 'just in case'."
- **`promptGuidelines` rule #2**: now explicit about the per-tool-call
  self-check ("After EVERY successful tool call, BEFORE starting any
  new action, ask yourself: 'Did this tool call just close the task I
  had in_progress?'"). Without this the model drifts — successful tool
  calls are followed by a new action, never by an explicit close.
- **`promptGuidelines` rule #3**: replaced the unverifiable "the
  implementation is partial" criterion (which the model uses as a
  default fallback to leave tasks open) with three concrete boolean
  conditions the model can verify mechanically: (a) tagged tool calls
  returned without `isError`; (b) tests for the task pass (or none
  exist); (c) no unresolved error in the current tool result stream.
  If any of (a)(b)(c) fails, KEEP the task in_progress and state the
  blocker in the `activeForm`.
- **Deferred**: a runtime `tool_execution_end` reminder via
  `sendMessage` was considered but skipped — `sendMessage` semantics
  on `@earendil-works/pi-coding-agent` aren't documented in the
  ambient shim and a wrong call risks breaking conversation flow. The
  text-based self-check covers the same gap without API-surface risk.
  Revisit if text-only is empirically insufficient.

## 0.2.0

Overlay can now be expanded to show every task, not just the 12-row cap.

- **New command subcommands on `/todos`**:
  - `/todos expand` — cancel the 12-row cap; render every visible task
    in the overlay. The collapsed-summary line is replaced with a
    `/todos collapse` hint so the toggle is always discoverable.
  - `/todos collapse` — return to the 12-row budget.
  - `/todos status` — report current state + visible task count.
  - `/todos` with no args still prints the grouped list (unchanged).
  - Empty / unknown subcommand returns an error notice with usage.
- **Per-session UI preference, NOT persisted to branch**. The expanded
  flag lives in the foreground slot in `store.ts`. Rationale: a UI
  toggle shouldn't (a) require replay to tolerate a missing field on
  legacy branches or (b) lock users out of starting a fresh session
  collapsed. After `/reload` or compaction the preference resets to
  collapsed — re-toggle with `/todos expand` is one keystroke.
- **Pure helpers extracted from `overlay.ts`** so the new behavior is
  testable: `computeShownTasks(visible, expanded, maxRows)` picks which
  rows render + counts the hidden ones; `formatOverflowSummary(...)`
  builds the gutter line including the new toggle hint.
- **Overflow summary now hints at the toggle**: the collapsed
  `+N more (X completed, Y pending)` line gains `· /todos expand` when
  anything is hidden, so the toggle is always visible in the panel
  itself rather than only discoverable via the command palette.
- **Tests**: 25 unit tests added — store flag ops (`getExpanded` /
  `setExpanded` / `clearExpanded` / `evictSession`), `computeShownTasks`
  across all branches (under cap / drop-completed / truncate-tail /
  expanded / boundary), `formatOverflowSummary` (collapsed-null /
  collapsed-overflow / expanded-always / mixed), and `/todos`
  subcommand parsing including mixed case + non-interactive guard.

## 0.1.1

- Pending overlay rows use the `muted` theme color instead of guessing
  a custom key — avoids an uncaught exception in pi's theme renderer
  when status variants appear.
- Initial published 0.1.0 was missing the `pending` color entry; the
  v0.1.1 fix maps pending → muted, in_progress → accent, completed →
  dim, and falls back to muted for unknown statuses.

## 0.1.0

- First public release. Tool + command + overlay, branch-replay state,
  8 semantic guarantees (id non-reuse, tombstone immutability, dep
  sanity, no-op detection, terminal sanitizer, per-session slots,
  foreground-follows-UI, zero render-time IO).
