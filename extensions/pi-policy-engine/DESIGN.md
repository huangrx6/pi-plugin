# Design — pi-policy-engine v0.12

## 1. Design goal

Provide a small **task-flow policy layer** for Pi without recreating a full
agent runtime. The extension works entirely at the **task-behavior layer**:
it injects execution-discipline constraints into the system prompt and runs
a strict-workflow state machine in `before_agent_start`. It does **not**
intercept tool calls — tool permission is out of scope by design, so the
extension composes with any permission extension (or none) without
coordination.

The extension owns:

- classification (deterministic + opt-in semantic fallback);
- policy composition (with byte-budget enforcement);
- workflow selection (quick / standard / strict);
- strict approval state machine;
- explainability + introspection (`/policy preview`, `why`, `diff`, `history`, `config`, `validate`).

The extension intentionally does not own:

- tool-call permission / approval dialogs (tool_call interception);
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
agent_end
```

`model_select` updates the current model identity used by model-specific policy routing.

No `tool_call` handler exists (v0.12+). See §6.

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

Implementation: `src/core/semantic.js` (`maybeSemanticClassify`) wired into `state.js::decide()` (which is `async` for this purpose).

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

Approval recognition lives in `src/core/approval.js` (`isApprovalPrompt` / `isPlanRevisionPrompt`) — a small phrase whitelist, deliberately conservative so ambiguous follow-ups don't accidentally release the gate.

## 6. No tool-call interception (v0.12)

Early versions shipped a mechanical gate (`soft`/`hard` tool_call blocking
during `pendingApproval`). That put this extension on the same layer as
permission extensions, creating overlap: when both were installed, both
evaluated the same tool calls (OR-composition, first block short-circuits),
and users had to reason about which one would win.

v0.12 removes the tool_call handler entirely:

- Strict planning relies on the injected `strict-plan` policy instruction
  ("This turn is PLAN-ONLY … Stop after the plan and ask for approval.")
  — the model is expected to stop on its own, exactly like a skill that
  says "ask the user here". No tool is invoked, so nothing needs blocking.
- Whether any tool call is *permitted* is someone else's job — whatever
  permission extension the user runs (if any). This extension neither knows
  nor cares about that layer.
- Consequence (documented as a known limitation): if a model ignores the
  PLAN-ONLY instruction and issues a mutation anyway, nothing here stops it.
  That's the deliberate price of clean layering.

`src/core/approval.js` is the only remnant of the old guard module, kept
because the strict state machine needs phrase recognition.

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

Read-only commands for tuning and debugging. They never mutate state, never invoke the agent, and never call the semantic fallback (except `/policy preview` when the user has explicitly raised the confidence threshold — see README).

### `/policy preview <prompt>`

Dry-runs the full routing + composition pipeline for a hypothetical prompt.
Pure read: runs `decide` with a **fresh** state (no runtime overrides applied).

### `/policy why`

Shows the last decision's full reasoning: workflow / phase / task / risk /
profile / domains / model policy / confidence, plus loaded policies,
truncated policies, and classification reasons.

### `/policy diff <promptA> || <promptB>`

Runs two previews in parallel and shows side-by-side decisions plus a
Differences list. Uses `compareDecisions` / `formatDiff`.

### `/policy history [N]` / `/policy history clear-disk`

In-memory routing history (default 5, cap 50). When `historyFile` is
configured (default `~/.pi/agent/policy-engine/history.jsonl`), entries are
also persisted and reloaded at `session_start`. See `src/core/history-store.js`.

### `/policy config`

Prints the **resolved effective config** (defaults < global < project <
runtime merged). Sections: routing / policies / semanticFallback.

### `/policy validate`

Checks the resolved config: include/exclude policy references, manifest
paths, profile entries. Pure read — safe to run in CI.

## 10. Extensibility

Global reusable policies use a manifest (`policies/manifest.json`) and profiles
(`profiles/*.json`). Project-only policies require no manifest.

Routing keywords are data-driven in `config/routing.json`, allowing
domain/task expansion without changing classifier code.

## 11. Extension file layout (v0.12)

```text
extensions/policy-engine/
├── index.js          # thin assembly: createState, register command + lifecycle
├── commands.js       # /policy command + interactive selector + all subcommands
├── lifecycle.js      # pi event handlers (no tool_call) + strict-workflow state machine
├── state.js          # createState + decide/preview/compareDecisions/validateConfig glue + history recording
├── format.js         # all command output formatters
└── helpers.js        # findPackageRoot / cleanModel / notify / setStatus / parsePolicyCommand

src/core/             # pure modules, no pi import dependency — testable in isolation
├── classifier.js     # rule-based task/risk/domain classification
├── router.js         # buildDecision (workflow + profile + model policy selection)
├── loader.js         # loadManifest / loadProfile / loadProjectPolicies / composePolicies / renderPolicyBlock
├── approval.js       # isApprovalPrompt / isPlanRevisionPrompt (strict state machine)
├── config.js         # loadEffectiveConfig / mergeConfig
├── semantic.js       # maybeSemanticClassify (opt-in OpenAI-compatible fallback)
└── history-store.js  # appendHistory / readHistory / clearHistory / resolveHistoryPath
```

## 12. Non-goals

If the extension evolves toward scheduler, DAG engine, worker pool, subagent
graph, generalized orchestration runtime, or tool-permission enforcement,
it has exceeded its intended boundary.

## 13. Independence from sibling extensions

Extensions in this monorepo are independent packages: no cross-imports, no
cross-tests, no cross-doc links. This extension follows that rule — it never
references another extension's existence in code, tests, or documentation
beyond a generic "tool permission is out of scope" statement.
