# Design — pi-policy-engine v0.11

## 1. Design goal

Provide a small policy layer for Pi without recreating a full agent runtime.

The extension owns:

- classification (deterministic + opt-in semantic fallback);
- policy composition (with byte-budget enforcement);
- workflow selection;
- strict approval state;
- targeted mutation guards (categorized, structural-parsed, configurable, extensible via custom patterns);
- explainability + introspection (`/policy preview`, `why`, `history`, `test-guard`, `config`).

The extension intentionally does not own:

- subagent orchestration;
- DAG execution;
- task queues;
- generalized workflow DSL;
- model provider abstraction;
- memory system.

## 2. Lifecycle

```text
session_start
    ├─ reset state (history, pendingApproval, etc.)
    ├─ compile custom mutating patterns from guard.customPatterns
    ├─ emit compile warnings once
    └─ set footer status
    ↓
user prompt
    ↓
before_agent_start
    ├─ classify task + risk + domains
    ├─ [opt-in] semantic fallback when deterministic confidence < threshold
    ├─ choose profile + workflow
    ├─ choose model adaptation
    ├─ composePolicies: enforce byte budget, drop low-priority tail
    ├─ load project policies (with file + byte caps)
    ├─ recordHistory(state, { source: 'decide', prompt, decision })
    └─ append active policy block to system prompt
    ↓
agent loop
    ↓
tool_call
    └─ if strict + awaiting approval: apply gate (per-category, with custom patterns)
    ↓
agent_end
```

`model_select` updates the current model identity used by model-specific policy routing.

## 3. Policy layers + byte budget

```text
Core
  └─ evidence / constraints / verification         ← always loaded
Behavior
  └─ execution discipline / scope / context / tools
Workflow
  └─ quick / standard / strict / debug / review / research
Domain
  └─ database / kubernetes / security / backend / frontend / docs
Model
  └─ model-specific adaptation                    ← MiniMax M3 / DeepSeek
Project
  └─ .pi/policies/**/*.md                         ← user-supplied
```

`composePolicies` walks the ordered list above and applies a **byte budget**
(default `policyMaxBytes: 24000`). When the running total exceeds the budget
the current policy is dropped entirely (no partial truncation — policies are
semantic units). Dropped ids surface via `/policy why` and `decision.truncatedPolicies`.

Priority order (high → low): core > profile behaviors > workflow > domain > model > project.

## 4. Classification: deterministic first, semantic as opt-in fallback

The main failure mode being addressed is unreliable execution discipline. Allowing the same model to decide which constraints it should receive creates a circular dependency, so the routing decision itself is **always** deterministic.

The opt-in **semantic fallback** is available for users who hit keyword-matching blind spots:

- Disabled by default. Any user who doesn't configure `semanticFallback.enabled: true` gets pure deterministic routing.
- When enabled, only invokes a one-shot HTTP call to an OpenAI-compatible endpoint when deterministic `confidence < confidenceThreshold` (default 0.7).
- The semantic result is **merged** on top of the deterministic classification (semantic wins per-field), and the merge is recorded in `decision.reasons` so `/policy why` shows it.
- **Failure isolation**: any error — timeout, network, HTTP non-2xx, JSON parse failure, schema mismatch, missing API key — returns `null` and the deterministic result stands. The agent loop never blocks on this.
- API key is read from an **environment variable name** (`apiKeyEnvVar`), never persisted to config files.

Implementation: `src/core/semantic.js` (`maybeSemanticClassify`) wired into `state.js::decide()` (which is `async` for this purpose). `lifecycle.js::before_agent_start` already runs in an `async` context, so the extra `await` is invisible.

Why opt-in rather than always-on:

1. **Privacy / offline**: many users run pi against private codebases and won't accept an extra outbound call by default.
2. **Latency**: even a 4 s timeout is a long time to wait for a routing decision that usually takes <1 ms.
3. **Cost**: even cheap models cost money; we shouldn't incur it without consent.
4. **Determinism contract**: deterministic routing is what users rely on for reproducibility. Making the fallback optional keeps that contract.

## 5. Strict workflow state

```text
idle
  ↓ high-risk task
planning + pendingApproval
  ↓ explicit approval
executing
  ↓ agent_end
idle
```

Any non-approval follow-up during `pendingApproval` remains in planning. This avoids accidental downgrade caused by a short prompt such as "why?" or "change step 2".

## 6. Gate semantics

```text
gate=off   → no mechanical blocking (only prompt-level constraints)
gate=soft  → block direct file mutation tools (write / edit / apply_patch …)
gate=hard  → soft + categorized shell mutation patterns
```

### Structural parsing (v0.3)

`splitShellSegments` splits a command at `&&`, `||`, `;`, and `|` boundaries respecting single/double quotes and `$(...)` substitution. Each non-empty trimmed segment is matched independently against the pattern table; patterns are now segment-anchored (`^X`) so they don't need the `(^|[;&|])` prefix anymore.

This fixes two classes of false positives the old flat regex produced:

- `echo "rm -rf /"` is no longer flagged (the rm is inside a quoted string).
- `kubectl apply -f x.yaml && sleep 5` is correctly flagged (segment header is `kubectl`).

And one class of false negatives:

- `echo $(rm -rf /tmp)` IS flagged — `findMutatingShell` shallow-extracts `$(...)` content and re-runs the matcher on the substitution body. Deeply nested `$($(...))` remains out of scope (documented as a known limitation).

### Categorized patterns (v0.4)

Built-in shell patterns are tagged with one of six categories:

| Category | Examples |
| --- | --- |
| `file`   | `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `sed -i`, `perl -pi`, `>`, `tee` |
| `git`    | `git add / commit / push / reset / checkout / switch / merge / rebase / clean / stash` |
| `package`| `npm / pnpm / yarn / bun / pip / apt / yum / dnf / brew / docker` install/remove/upgrade |
| `k8s`    | `kubectl apply / delete / patch / edit / scale / rollout / set / create / replace / label / annotate`, `helm install / upgrade / uninstall / rollback` |
| `network`| (reserved; no built-in patterns yet) |
| `disk`   | `mkfs.*`, `dd of=` |

Each category can be independently enabled/disabled via `config.guard`:

```json
{
  "guard": {
    "enabledCategories": ["file", "git", "k8s"],
    "disabledCategories": ["disk"]
  }
}
```

`shouldBlockTool` reason includes `[category: label]` and the offending segment (truncated to 120 chars) so the model can self-correct without guessing.

### Custom patterns (v0.4)

Users can add project/company-specific mutating shell patterns via `guard.customPatterns`:

```json
{
  "guard": {
    "customPatterns": [
      { "category": "file", "label": "deploy-tool-prod", "regex": "deploy-tool\\s+prod" }
    ]
  }
}
```

- `category` must be one of the 6 known buckets (participates in `enabledCategories` / `disabledCategories`).
- `regex` is compiled with `new RegExp(str, "i")` once per session.
- Misconfiguration (unknown category, empty label, unparseable regex) does NOT crash the agent: collected as warnings, surfaced once at `session_start` via `ctx.ui.notify`.
- Custom patterns are tried before built-ins, so users can shadow labels.

## 7. Project policy discovery

Project policies live at `<cwd>/.pi/policies/**/*.md`. Limits prevent unbounded
context growth:

- `projectPolicyMaxFiles` (default 12)
- `projectPolicyMaxBytes` (default 24000)
- `projectPolicies` allowlist (optional)

## 8. Configuration merging

`mergeConfig(defaults, global, project, runtimeOverrides)`:

- Plain objects: **deep** merge (recursive). v0.1 had a shallow-merge bug that
  silently dropped nested keys; fixed in v0.2.
- Arrays of objects with `id`: deduped by id with later-override semantics.
- Arrays without `id`: replaced wholesale.
- Scalars: replaced.

## 9. Introspection commands

These are read-only commands for tuning and debugging. They never mutate state, never invoke the agent, and never call the semantic fallback.

### `/policy preview <prompt>`

Dry-runs the full routing + composition pipeline for a hypothetical prompt.
Output includes classification, decision, loaded built-in policies (id + byte usage + % of budget), truncated ids, project policies (id + byte usage), and classification reasons.

Pure read: runs `decide` with a **fresh** state (no runtime overrides applied) so the preview reflects defaults + global + project config, not any in-session overrides.

### `/policy why`

Shows the last decision's full reasoning: workflow / phase / task / risk / profile / gate / domains / model policy / confidence, plus loaded policies, truncated policies, and classification reasons.

### `/policy history [N]`

Shows the last N routing decisions recorded in this session (default 5, cap 50). Each entry: 1-based index, HH:MM:SS timestamp, source (`decide` or `preview`), workflow, task/risk, confidence, and prompt summary (≤ 80 chars one-line).

Entries are pushed by:

- `before_agent_start` after each `decide` call (source: `decide`)
- `/policy preview` handler after each preview run (source: `preview`)

`session_start` resets the history array. No disk writes.

### `/policy test-guard <bash command>`

Simulates the gate against a sample command without entering strict mode. Pretends `pendingApproval=true` so the result matches what the agent would actually see during a strict workflow. Reports whether the command would block, plus matched category / label / segment / reason.

Useful for verifying `guard.customPatterns` and `disabledCategories` without firing a real tool_call.

### `/policy config`

Prints the **resolved effective config** (defaults < global < project < runtime merged). Sections: routing / policies / guard / semanticFallback. Shows resolved values only, not which layer overrode which.

### `/policy diff <promptA> || <promptB>`

Runs the full preview pipeline for two prompts in parallel and shows the resulting decisions side by side, plus a Differences list of fields that changed. Pure read — no agent invocation, no state mutation, no semantic fallback HTTP call.

Separator is `||` (no surrounding spaces required). Falls back to a usage warning if the separator is missing.

Uses `compareDecisions(left, right)` from state.js and `formatDiff(...)` from format.js.

### `/policy validate`

Proactively checks the resolved config for common mistakes before they bite at runtime:

- `guard.customPatterns`: unknown category / unparseable regex / empty label / empty regex → errors (reuses `compileCustomPatterns` from guard.js).
- `includePolicies` / `excludePolicies`: ids not in the package manifest and not under `core.*` / `model.*` → warnings. The composer silently ignores unknown ids.
- `policies/manifest.json`: each entry's path checked against the filesystem → errors when missing.
- `profiles/*.json`: each entry checked against manifest + built-in prefixes → errors when unknown.

Output: one-line verdict (`OK` / `OK (with warnings)` / `FAIL (N errors)`), Errors block, Warnings block.

Pure read — safe to run in CI. Uses `validateConfig({ config, packageRoot })` from state.js and `formatValidation(...)` from format.js.

### `/policy history [N]` / `/policy history clear-disk`

In-memory routing history (default 5, cap 50). When `historyFile` is configured (default `~/.pi/agent/policy-engine/history.jsonl`), entries are also persisted to disk and reloaded at `session_start`:

- Append-only writes to a JSONL file (`{ts, source, prompt, task, risk, workflow, profile, gate, confidence}` per line).
- On read: tail-scan the file for the most recent `historyMaxEntries` lines (default 500), parsed and reversed into chronological order.
- Best-effort writes: any I/O failure (EACCES, ENOSPC) is swallowed; the in-memory history still works.
- `clear-disk` truncates the file (also clears the in-memory list).

Wired in `lifecycle.js::session_start` (load) and after each `recordHistory()` call (append). The `/policy preview` handler also appends. Persistence module: `src/core/history-store.js`.

## 10. Extensibility

Global reusable policies use a manifest (`policies/manifest.json`) and profiles
(`profiles/*.json`). Project-only policies require no manifest.

Routing keywords are data-driven in `config/routing.json`, allowing
domain/task expansion without changing classifier code.

Gate categories are data-driven in `src/core/guard.js` `MUTATING_SHELL_PATTERNS`. Adding a new category:

1. Add the entry `{ category, label, pattern }` to the array.
2. Add the category id to `ALL_CATEGORIES`.
3. (Optional) Wire it into `config/defaults.json`.

For project/company-specific patterns without forking: use `guard.customPatterns` (v0.4).

## 11. Extension file layout (v0.11)

```text
extensions/policy-engine/
├── index.js          # thin assembly: createState, register command + lifecycle
├── commands.js       # /policy command + interactive selector + all subcommands
├── lifecycle.js      # pi event handlers + strict-workflow state machine + disk history
├── state.js          # createState + decide/preview/compareDecisions/validateConfig glue + history recording
├── format.js         # formatDecision / formatStatusSummary / formatPreview /
│                     #   formatHistory / formatGuardPreview / formatConfig /
│                     #   formatDiff / formatValidation
└── helpers.js        # findPackageRoot / cleanModel / notify / setStatus / parsePolicyCommand

src/core/             # pure modules, no pi import dependency — testable in isolation
├── classifier.js     # rule-based task/risk/domain classification
├── router.js         # buildDecision (workflow + profile + model policy selection)
├── loader.js         # loadManifest / loadProfile / loadProjectPolicies / composePolicies / renderPolicyBlock
├── guard.js          # shouldBlockTool / previewGuard / splitShellSegments / compileCustomPatterns / findMutatingShell
├── config.js         # loadEffectiveConfig / mergeConfig
├── semantic.js       # maybeSemanticClassify (opt-in OpenAI-compatible fallback)
└── history-store.js  # appendHistory / readHistory / clearHistory / resolveHistoryPath (best-effort JSONL persistence)
```

## 12. Non-goals

If the extension evolves toward scheduler, DAG engine, worker pool, subagent
graph, or generalized orchestration runtime, it has exceeded its intended
boundary.

## 13. Boundary with sibling extensions

- `pi-mode-switcher` is **per-tool** human approval. This extension is
  **per-task** automatic plan-then-execute. They are orthogonal and stack:
  mode-switcher gates each tool, policy-engine gates the whole task.
- `pi-skill-inject` injects skill content into the current turn. Policy
  composes Markdown policies into the system prompt. Same injection plumbing,
  different content source.
- `pi-quota-status` is display-only. No policy interaction.
