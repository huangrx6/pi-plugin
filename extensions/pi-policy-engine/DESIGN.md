# Design — pi-policy-engine v0.2

## 1. Design goal

Provide a small policy layer for Pi without recreating a full agent runtime.

The extension owns:

- classification;
- policy composition (with byte-budget enforcement);
- workflow selection;
- strict approval state;
- targeted mutation guards (categorized, configurable);
- explainability.

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
    ↓
user prompt
    ↓
before_agent_start
    ├─ merge defaults/global/project/runtime config (deep merge)
    ├─ classify task + risk + domains
    ├─ choose profile + workflow
    ├─ choose model adaptation
    ├─ load project policies (with file + byte caps)
    ├─ composePolicies: enforce byte budget, drop low-priority tail
    └─ append active policy block to system prompt
    ↓
agent loop
    ↓
tool_call
    └─ if strict + awaiting approval: apply gate (per-category)
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

V0.3 keeps deterministic classification as the only contract. An opt-in **semantic fallback** is available for users who hit keyword-matching blind spots:

- Disabled by default. Any user who doesn't configure `semanticFallback.enabled: true` gets pure deterministic routing, identical to v0.2.
- When enabled, only invokes a one-shot HTTP call to an OpenAI-compatible endpoint when deterministic `confidence < confidenceThreshold` (default 0.7).
- The semantic result is **merged** on top of the deterministic classification (semantic wins per-field), and the merge is recorded in `decision.reasons` so `/policy why` shows it.
- **Failure isolation**: any error — timeout, network, HTTP non-2xx, JSON parse failure, schema mismatch, missing API key — returns `null` and the deterministic result stands. The agent loop never blocks on this.
- API key is read from an **environment variable name** (`apiKeyEnvVar`), never persisted to config files.

The implementation lives in `src/core/semantic.js` (`maybeSemanticClassify`) and is wired into `state.js::decide()` (made `async` for this purpose). `lifecycle.js::before_agent_start` already runs in an `async` context, so the extra `await` is invisible.

Why opt-in rather than always-on:

1. **Privacy / offline**: many users run pi against private codebases and won't accept an extra outbound call by default.
2. **Latency**: even a 4 s timeout is a long time to wait for a routing decision that usually takes <1 ms.
3. **Cost**: even cheap models cost money; we shouldn't incur it without consent.
4. **Determinism contract**: deterministic routing is what users rely on for reproducibility (`/policy why` is a deterministic function of the prompt). Making the fallback optional keeps that contract.



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

V0.2 shell mutation patterns are **categorized**:

| Category | Examples |
| --- | --- |
| `file`   | `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `sed -i`, `perl -pi`, `>`, `tee` |
| `git`    | `git add / commit / push / reset / checkout / switch / merge / rebase / clean / stash` |
| `package`| `npm / pnpm / yarn / bun / pip / apt / yum / dnf / brew / docker` install/remove/upgrade |
| `k8s`    | `kubectl apply / delete / patch / edit / scale / rollout / set / create / replace / label / annotate`, `helm install / upgrade / uninstall / rollback` |
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

The `shouldBlockTool` reason string includes the matched `[category: label]` so the model can self-correct.

The shell classifier is intentionally a **conservative regex set**, not a full AST parser. Treat `hard` gate as a safety net, not an infallible validator.

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

## 9. Extensibility

Global reusable policies use a manifest (`policies/manifest.json`) and profiles
(`profiles/*.json`). Project-only policies require no manifest.

Routing keywords are data-driven in `config/routing.json`, allowing
domain/task expansion without changing classifier code.

Gate categories are data-driven in `src/core/guard.js` `MUTATING_SHELL_PATTERNS`. Adding a new category:

1. Add the entry `{ category, label, pattern }` to the array.
2. Add the category id to `ALL_CATEGORIES`.
3. (Optional) Wire it into `config/defaults.json`.

## 10. Extension file layout (v0.2)

```text
extensions/policy-engine/
├── index.js          # thin assembly: createState, register command + lifecycle
├── commands.js       # /policy command + interactive selector (mode / gate / profile)
├── lifecycle.js      # pi event handlers + strict-workflow state machine
├── state.js          # createState + decide() glue (classifier → router)
├── format.js         # formatDecision / formatStatusSummary
└── helpers.js        # findPackageRoot / cleanModel / notify / setStatus / parsePolicyCommand
```

`src/core/` holds the pure modules with no pi import dependency — testable in isolation.

## 11. Non-goals

If the extension evolves toward scheduler, DAG engine, worker pool, subagent
graph, or generalized orchestration runtime, it has exceeded its intended
boundary.

## 12. Boundary with sibling extensions

- `pi-mode-switcher` is **per-tool** human approval. This extension is
  **per-task** automatic plan-then-execute. They are orthogonal and stack:
  mode-switcher gates each tool, policy-engine gates the whole task.
- `pi-skill-inject` injects skill content into the current turn. Policy
  composes Markdown policies into the system prompt. Same injection plumbing,
  different content source.
- `pi-quota-status` is display-only. No policy interaction.
