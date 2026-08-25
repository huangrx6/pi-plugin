# Changelog

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
  + policy composition pipeline for the given prompt without touching
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
