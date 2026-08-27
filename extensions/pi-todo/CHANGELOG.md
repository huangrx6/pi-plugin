# Changelog

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
