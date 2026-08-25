# Changelog

## 0.12.0

- **Removed the tool-call gate entirely**. The extension is now purely
  task-behavior layer: strict planning injects a PLAN-ONLY instruction and
  the model stops to ask for approval itself (like a skill that says "ask
  the user here"). No `tool_call` handler exists. This makes the extension
  fully independent of any permission extension — it neither blocks tools
  nor depends on another extension's behavior.
- Deleted `src/core/guard.js` (shouldBlockTool / previewGuard /
  splitShellSegments / compileCustomPatterns / findMutatingShell); replaced
  by `src/core/approval.js` (isApprovalPrompt / isPlanRevisionPrompt only).
- Removed `/policy gate` and `/policy test-guard` commands; `gate` removed
  from interactive selector, decision, config, format, defaults.
- Removed `guard.customPatterns` / enabledCategories / disabledCategories
  config and validation.
- Removed the cross-extension coexistence matrix and interop harness (the
  extension never references another extension now).
- Known limitation (documented): PLAN-ONLY is a soft constraint — a model
  that ignores it won't be mechanically stopped; that's the deliberate
  price of clean layering.

## 0.11.1

- **Fix (hard gate regression)**: `ls 2>/dev/null`, `grep … 2>/dev/null`,
  `echo x > /dev/null 2>&1` and every other /dev/null silencing idiom were
  falsely blocked by the hard gate's redirect pattern. The v0.3
  segment-anchored rewrite dropped the /dev/null exemption that v0.1 had;
  fd duplication (`2>&1`, `>&2`) was also caught. Redirect now requires a
  real (non-/dev/null, non-fd) file target. Includes a regex backtracking
  trap fix: `>>` could satisfy the lookahead via its second `>`.
- **Fix (preview history never persisted)**: `/policy preview` entries were
  never appended to historyFile — the handler read `result.config?.historyFile`
  but `preview()` never returned a `config` field, so the append was dead
  code since v0.9. `preview()` now returns the resolved config.
- **Cleanup**: removed a no-op block in session_start that misused
  `customPatternWarningsEmitted` as a dedup flag for disk-history loading
  (it could swallow customPattern warning semantics on /reload).
- **Perf**: session_start now reads at most `HISTORY_CAP` entries from the
  history file instead of `historyMaxEntries` (default 500) lines that were
  immediately sliced down to 50.
- Regression tests added for both fixes (silencing-vs-real-write matrix,
  preview config field contract).

## 0.11.0

- **Config validation**: `/policy validate` proactively checks the resolved
  config for common mistakes before they bite at runtime:
  - `guard.customPatterns`: unknown category / unparseable regex /
    empty label / empty regex -> errors (same as session_start warnings).
  - `includePolicies` / `excludePolicies`: ids not in the package manifest
    and not under `core.*` / `model.*` -> warnings (these are silently
    ignored by the composer).
  - `policies/manifest.json`: each entry's path checked against the
    filesystem -> errors when missing.
  - `profiles/*.json`: each entry checked against manifest + built-in
    prefixes -> errors when unknown.
- Pure read — no state mutation, no agent invocation, safe to run in CI.
- New helpers: `validateConfig({ config, packageRoot })` in state.js,
  `formatValidation(result)` in format.js.

## 0.10.0

- **Side-by-side routing comparison**: `/policy diff <promptA> || <promptB>`
  runs the full preview pipeline for two prompts in parallel and shows
  the resulting decisions next to each other, with a Differences list of
  fields that changed. Pure read — no agent invocation, no state mutation.
  Useful for verifying that a routing keyword change actually moved
  prompts between workflows.
- New helpers in state.js (`compareDecisions`) and format.js
  (`formatDiff`). Both used by `/policy diff` and reusable for future
  comparison-style commands.

## 0.9.0

- **Cross-session history persistence**: `/policy history` now reads from
  `~/.pi/agent/policy-engine/history.jsonl` (JSONL) at session_start and
  appends every decision to it. Default-enabled; opt out with
  `historyFile: ""` in `policy-engine.json`. Cap reads with
  `historyMaxEntries` (default 500). `/policy history clear-disk` truncates
  the file.
- Best-effort writes: disk failures (EACCES, ENOSPC) are swallowed; the
  in-memory history still works. No corruption risk because writes are
  append-only.
- New module: `src/core/history-store.js` exports `appendHistory`,
  `readHistory`, `clearHistory`, `resolveHistoryPath`,
  `defaultHistoryPath`. All accept an optional `fs` override for testing.

## 0.8.0

- **Resolved config dump**: `/policy config` prints the effective merged
  configuration (defaults < global < project < runtime). Useful for
  debugging "why is this value different from what I configured?" without
  manually diffing the four JSON sources.
- Sections: routing / policies / guard / semanticFallback, with all
  fields including customPatterns count, enabled/disabled categories,
  include/exclude policies, and semantic fallback key/model/endpoint.

## 0.7.0

- **Guard dry-run**: `/policy test-guard <bash command>` simulates the gate
  against a sample command without entering strict mode. Reports whether
  the command would be blocked, with category, label, matched segment, and
  reason. Useful for verifying `guard.customPatterns` and `disabledCategories`
  without accidentally triggering a real block.

## 0.6.0

- **In-session routing history**: `/policy history [N]` shows the last N
  routing decisions (default 5, cap 50) made via either `before_agent_start`
  or `/policy preview`. Useful for tuning `config/routing.json` keywords:
  change a keyword, send a few prompts, then `/policy history` to see how
  routing actually shifted.
- Entries are in-memory only; cleared on `session_start`. No disk writes.

## 0.5.0

- **Dry-run preview**: `/policy preview <prompt...>` runs the full routing
  - policy composition pipeline for the given prompt without touching
  the agent loop, mutating state, or calling the semantic fallback.
  Useful for tuning config/routing.json keywords, verifying new policies
  aren't truncated by the byte budget, and confirming custom patterns
  are loaded.

## 0.4.0

- **Config-driven custom mutating patterns**: `guard.customPatterns`
  lets users add project/company-specific mutating shell patterns
  without editing source code. Each entry is `{ category, label, regex }`;
  invalid entries (unknown category, empty label, unparseable regex) are
  collected as warnings and surfaced once at session_start rather than
  crashing the agent. Custom patterns are tried before built-ins, so users
  can shadow labels.

## 0.3.0

- **Structural shell parsing**: `splitShellSegments` splits a command at
  `&&`, `||`, `;`, `|` boundaries respecting quotes and `$(...)`. Patterns
  are now segment-anchored. Fixes false positives like `echo "rm -rf /"`
  and false negatives like `kubectl apply -f x && sleep 5`. `$(...)`
  contents are shallow-extracted and re-matched, so `echo $(rm /tmp)` is
  still flagged as a deletion.
- **Semantic fallback (opt-in)**: `semanticFallback` config block enables
  an OpenAI-compatible HTTP call when deterministic confidence is below
  threshold. Disabled by default; any failure silently falls back to
  deterministic. API key read from env var name, never stored in config.
  `decide()` is now `async`.
- Block reason now includes the offending segment (truncated to 120 chars)
  so the model can self-correct.

## 0.2.0

- README rewritten as quickstart-first; DESIGN moves to dedicated doc.
- `/policy` with no args opens an interactive selector (mode / gate / profile).
- `index.js` split into focused modules (state / format / commands / lifecycle / index).
- `composePolicies` now enforces a token budget with priority-based truncation; truncated ids surface via `/policy why`.
- `mergeConfig` deep-merges nested objects and dedupes arrays by id.
- `guard.js` shell mutation patterns categorized (file, git, package, k8s, network, disk) and
  made configurable per category.
- Added `.github/workflows/ci.yml` running `npm run check` and `npm test`.
- `examples/README.md` added; `examples/project` expanded with one more sample policy.
- Cross-extension note in root README: mode-switcher vs policy-engine boundaries.

## 0.1.0

- Initial Policy Router + Runtime Guard.
- Automatic quick / standard / strict routing.
- Deterministic task, risk, and domain classifier.
- Core, behavior, workflow, domain, and model policy layers.
- MiniMax M3 adaptation policy.
- Project-local `.pi/policies` discovery.
- Global/project/runtime configuration merge.
- `/policy` commands with explainability.
- Strict approval state and soft/hard tool guards.
- Self tests and extension lifecycle smoke tests.
