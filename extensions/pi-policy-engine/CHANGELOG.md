# Changelog

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
