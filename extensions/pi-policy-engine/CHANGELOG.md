# Changelog

## 0.17.0

Advisory-vs-mutation intent + unified policy budget (v1.0 P0 follow-ups).

- **Action modality: "tell me how" ≠ "do it"**. intent.js now classifies
  each mutation-verb hit as live / advisory / dead before any verdict:
  - clause-initial communication verbs (告诉我/解释/建议/show me…),
  - interrogative scope (怎么/如何/how to/what should) before the verb,
  - plan-noun compounds under a communication frame (给我部署步骤/修复方案)
  → ADVISORY mutations are read-only requests for guidance. Verified fixes:
  "告诉我如何修复这个问题，不要修改代码" / "不要改代码，只告诉我应该怎么
  修改" / "分析一下怎么修改这个接口" / "不要部署，只给我部署步骤" were all
  mutate (strict would have demanded approval for a change nobody asked
  for); now read-only. A BARE plan-noun without a communication frame
  ("设计…迁移方案") stays dead evidence — intent unclear, strict rigor
  holds via risk. Public enum unchanged (read-only/mutate/unclear).
- Direct commands sharpened: 实施/执行/change added to MUTATION_VERBS —
  "…迁移方案并实施" now correctly reads mutate (was unclear), so the
  flagship strict scenario gets its approval gate.
- **Approval grammar widened safely**: 并 added to filler, bare 开始 and
  "looks good" added to approval phrases. "批准并执行" / "没问题，直接
  开始" / "looks good, proceed" are approve again (were revise). No
  reverse enumeration reintroduced — strip-then-inspect-remainder
  unchanged; constraint-bearing approvals still revise.
- **Unified policy budget** (real bug): composePolicies and
  loadProjectPolicies were each capped independently, so the injected
  block could reach policyMaxBytes + projectPolicyMaxBytes (verified 700
  budget → 1433 bytes injected) while /policy preview reported only the
  built-in share. New composeAllPolicies composes both under ONE
  policyMaxBytes (built-ins first, project gets the remainder); lifecycle
  and preview both use it; budgetUsedPct and the preview budget line now
  report the true total.
- Regression corpus +7 (advisory×5, approval×3 minus dup) → 30 cases.

## 0.16.0

Pure classification-correctness release (v1.0 P0 batch complete). No new
features.

- **Intent Frame wired into the classifier** (P0-3/P0-4, "Intent beats
  mention"). `extractIntentFrame()` now scans ALL clauses (not just the
  first), prefers imperative-marked ones (帮我/请/需要/please…), and the
  last correction wins. Task scoring weights groups matched inside the
  frame double, mention evidence half, plus a +2 frame anchor:
  "README 里记录了之前架构拆分失败的原因，现在帮我把这段文档改准确"
  now routes to documentation/low/mutate (was architecture/high — the
  background 架构/拆分 mention outweighed the actual request).
- **English / spaced negation fixed** (P0-1). The interstitial window
  between negator and verb now tolerates spaces and English particles
  (just/only/directly/please/simply), and the negator table gained
  dont / can not / should not / must not / will not / won't / never /
  不需要 / 无须. "don't fix it, just analyze" → read-only (was mutate).
- **Signal groups in routing.json + classifier** (P0-5). Task rules and
  domain rules now use alias groups via `matchSignalGroups`: word forms
  (debug/debugging/debugged, error/errors) and translations (api/接口/
  endpoint) are ONE signal; distinct groups are independent evidence.
  Fixes the word-boundary word-form gap ("debugging issue in parser"
  fell back to coding) and the api+接口 double-count that loaded the
  backend policy from one concept. coding base score lowered 1 → 0.5 so
  a single real task group beats the default honestly.
- **Pure Approval grammar** (P0-6). classifyPlanResponse now strips a
  whitelist of approval phrases and inspects the REMAINDER instead of
  enumerating revise markers: empty/filler → approve, question → discuss,
  anything left → revise. "批准，执行前先备份数据库" / "批准，别忘了
  跑测试" are now revise (were approve); "批准，先执行吧" is approve
  again (v0.15 SCOPE_LIMIT false positive — 先 here means "you may
  start"); bare "继续" stays unknown (never releases).
- **Semantic conservative merge** (P0-7). risk can only go UP
  (max-rank), executionIntent locked unless deterministic=unclear,
  domains enum-validated + capped with deterministic domains never
  dropped, and the model no longer self-reports confidence (the engine
  keeps its own number; the hint payload no longer includes it).
- NOUN_SUFFIXES narrowed to the verified 方案/计划 family — object nouns
  like 文档 ("更新文档" = update the docs) are live mutations, not topic
  mentions.
- Confidence dispersion curve tightened (×35 → ×50): a 6-vs-4 split now
  reports ~0.73 instead of ~0.79.
- **Test suite split** into `tests/*.test.js` (node:test, 101 cases)
  plus `tests/regression-corpus.json` — every real misclassification
  found in this extension is frozen as an expectation. New-bug workflow:
  reproduce → fix → add a corpus entry. self-test.mjs retired.
- history-store: parent directory auto-created (0o700) before first
  append — the default ~/.pi path silently failed to persist when the
  directory didn't exist; file created 0o600; fsync comment corrected.
- `/policy off` description aligned with behavior (model adaptation is
  also off); formatConfig duplicate `profile:` line removed; DESIGN
  header version fixed.

## 0.15.0

- **classifyPlanResponse replaces isApprovalPrompt** (v1.0 P0-3). Five-way
  plan-response classification: approve / revise / discuss / cancel /
  unknown. Core principle: only a PURE approval releases execution —
  "批准，但是不要改数据库" and "可以执行，不过只先做第一步" are now REVISE
  (constraint-bearing responses previously released execution as approvals;
  confirmed empirically before this fix).
- State machine formalized (single source of truth = `phase`, the
  pendingApproval boolean removed):
  idle → planning → (agent_end) → awaiting_approval →
    approve → executing → (agent_end) → idle
    revise  → planning (re-approval required)
    discuss → awaiting_approval
    cancel / unknown → awaiting_approval / idle
- awaiting_approval branch routes every follow-up through the classifier;
  unknown responses now inject an explicit "still awaiting approval"
  reminder instead of silently falling through to a fresh classification
  (which previously let casual prompts like 继续 downgrade the workflow).
- QUESTION detection widened (什么/哪些) so plan questions classify as
  discuss rather than unknown.

## 0.14.0

- **executionIntent replaces analysisOnly** (v1.0 P0-2). The old boolean
  had a negation-scoping bug: "不要只分析，直接修改代码" was classified as
  analysis-only because the substring 只分析 matched while 不要 went
  unnoticed. New three-value intent, extracted per-clause with negation
  windows:
  - "mutate" — any live mutation verb (修复 / 修改 / refactor …)
  - "read-only" — live read-only verb and no mutation (分析 / review / 排查 …)
  - "unclear" — only ambiguous verbs (看看 / check out) or nothing
  - Topic-mention suppression: 迁移方案 / 写了 are nouns/narration, not
    action requests.
- Strict workflow now keys off `intent === "read-only"` to skip the
  approval cycle; "unclear" keeps full rigor (can't prove it won't mutate).
- Risk keyword matching moved to matcher.js — fixes "reproduction steps"
  matching risk:high via production → prod substring nesting.
- Semantic fallback schema: executionIntent is an optional enum field;
  when absent the deterministic intent stands (conservative merge).
- Removed deprecated analysisOnlyHints from routing.json / config fallback.
- Version alignment: package.json was stuck at 0.12.0 while CHANGELOG said
  0.13.0 (AGENTS.md rule #2 violation).

## 0.13.0

- **Classifier noise reduction** (宁可不加载，不要加载错):
  - Domain keywords split into `strong` / `weak` tiers in routing.json.
    Strong hits (postgres, react, jwt, kubectl …) trigger a domain
    immediately; weak hits (组件, api, 权限, sql …) need co-occurrence —
    2+ distinct weak terms in the same domain, or a strong frame term.
    A bare "组件" no longer drags in the whole frontend policy.
  - Domains are ranked by score and capped at `maxDomains` (default 2).
    Dropped domains are logged in reasons with the exact cause:
    weak-only / capped-at-N.
  - Confidence now accounts for candidate dispersion: dominance =
    (top − runner-up) / top; near-ties pay up to 0.35 penalty, runaway
    winners pay ~nothing. A 7/6/6 task split now reports ~0.60 instead of
    the old dishonest 0.95.
  - Legacy array-form domainRules keep the old any-match-triggers behavior
    for user-authored configs (backward compatible).
  - profiles that already carry a workflow.* policy no longer get the
    generic workflow.standard injected alongside it (debugging profile was
    loading debug-first AND standard simultaneously).
- New config: `maxDomains` (default 2).
- `/policy why` reasons now explain every domain drop and every confidence
  adjustment.

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
