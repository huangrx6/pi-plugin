# Design — pi-policy-engine v0.23

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
- rigor selection (quick / standard / strict) + flow selection (v0.19);
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

## 1a. Foundational principles (frozen at 1.0)

These eight principles are the contract. Any change that violates one of
them is a regression, not a feature.

1. **Deterministic first.** Routing is rule-based; the optional semantic
   model only arbitrates below the confidence threshold.
2. **Intent beats mention.** A discussed topic is not a request — the
   imperative frame and action modality decide, background keywords
   only weigh in.
3. **Hard evidence is never downgraded.** Semantic merge can raise risk,
   never lower it; deterministic intent is locked unless unclear.
4. **Less policy is better.** One unified byte budget; every loaded
   policy must have earned its slot with evidence.
5. **Strict approval must be pure.** Only a pure approval releases
   execution; any constraint remainder is a revise.
6. **Every route must be explainable.** Every decision carries reasons;
   dropped policies and domains say why they were dropped.
7. **Enforce workflow, not permissions.** No tool_call interception;
   the extension constrains task behavior, not tool access.
8. **Never become another agent runtime.** No schedulers, DAGs,
   subagent graphs, or orchestration — see Non-goals (§12).

## 2. Lifecycle

```text
session_start
    ├─ reset state (history, phase, etc.)
    └─ set footer status
    ↓
user prompt
    ↓
before_agent_start
    ├─ classify task + risk + domains
    ├─ [opt-in] semantic fallback when deterministic confidence < threshold
    ├─ choose profile + rigor + flow
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
Rigor
  └─ quick / standard / strict          ← how strict (v0.19)
Flow
  └─ debug-first / review-first / research-first   ← how to work
Domain
  └─ database / kubernetes / backend / frontend / docs
Concern
  └─ security / production            ← cross-cutting, not capped (v0.18)
Model
  └─ model-specific adaptation                    ← MiniMax M3 / DeepSeek
Project
  └─ .pi/policies/**/*.md                         ← user-supplied
```

`composePolicies` walks the ordered list above and applies a **byte budget**
(default `policyMaxBytes: 24000`). When the running total exceeds the budget
the current policy is dropped entirely (no partial truncation — policies are
semantic units). Dropped ids surface via `/policy why` and `decision.truncatedPolicies`.

**v0.17 unified budget**: built-in and project policies share ONE
`policyMaxBytes`. `composeAllPolicies` loads built-ins first (priority
order), then gives project policies the remaining space
(`min(projectPolicyMaxBytes, policyMaxBytes - builtInBytes)`). Before
v0.17 the two lists were capped independently, so the injected block
could reach `policyMaxBytes + projectPolicyMaxBytes` while
`/policy preview` reported only the built-in share — verified 700-byte
budget injecting 1433 bytes. `budgetUsedPct` now reports the true total.

Priority order (v0.23, one budget walk): core > **project** > **intent** >
flow > rigor > concern > domain > profile behaviors > model. The intent
policy (policies/intents/) is a HARD BOUNDARY — intent.read-only forbids
mutation outright and rigor policies are intent-neutral (mutation guidance
only under an explicit conditional). Intent decides WHETHER, rigor decides
HOW DEEP, flow decides HOW. A repo's own constraints
outrank generic model adaptation when the budget is tight — project
policies used to be dropped first, which inverted that.

## 4. Classification: deterministic first, semantic as opt-in fallback

The main failure mode being addressed is unreliable execution discipline. Allowing the same model to decide which constraints it should receive creates a circular dependency, so the routing decision itself is **always** deterministic.

The opt-in **semantic fallback** is available for users who hit keyword-matching blind spots:

- Disabled by default. Any user who doesn't configure `semanticFallback.enabled: true` gets pure deterministic routing.
- When enabled, only invokes a one-shot HTTP call to an OpenAI-compatible endpoint when deterministic `confidence < confidenceThreshold` (default 0.7).
- v0.16 **conservative merge** — the semantic model arbitrates ambiguity, it can never override deterministic hard evidence:
  - `taskType`: semantic may arbitrate (it only runs below the confidence threshold).
  - `risk`: `max(deterministic, semantic)` — can only go UP.
  - `executionIntent`: locked unless deterministic said `unclear`.
  - `domains`: deterministic always kept; semantic may ADD enum-validated extras up to the cap (an LLM hallucinating unknown domains is filtered before the merge).
  - `confidence`: the engine keeps its own number; the model does not self-report confidence, and the deterministic hint sent to the model no longer includes it.
- The merge is recorded in `decision.reasons` so `/policy why` shows exactly what was arbitrated.
- **Failure isolation**: any error — timeout, network, HTTP non-2xx, JSON parse failure, schema mismatch, missing API key — returns `null` and the deterministic result stands. The agent loop never blocks on this.
- API key is read from an **environment variable name** (`apiKeyEnvVar`), never persisted to config files.

Implementation: `src/core/semantic.js` (`maybeSemanticClassify`) wired into `state.js::decide()` (which is `async` for this purpose).

Why opt-in rather than always-on:

1. **Privacy / offline**: many users run pi against private codebases and won't accept an extra outbound call by default.
2. **Latency**: even a 4 s timeout is a long time to wait for a routing decision that usually takes <1 ms.
3. **Cost**: even cheap models cost money; we shouldn't incur it without consent.
4. **Determinism contract**: deterministic routing is what users rely on for reproducibility. Making the fallback optional keeps that contract.

### Sequential intent resolution (v0.20)

Intent resolves across clauses IN ORDER — the user's last effective
instruction wins. Correction heads (不对/等等/算了/actually/scratch
that…) clear the active intent; a negated clause revokes only the same
kind it negates ("只分析，不要修改" stays read-only — the negation
targets mutation, not analysis). Advisory clauses (告诉我如何修复 /
给我部署步骤) read as read-only guidance requests. Before v0.20, "any
live mutation short-circuits" let "先修改代码，不要修改，只分析"
classify as mutate. The intent frame skips clauses before the last
correction, so "帮我修复，不对，先别改，只分析原因" anchors on 分析.

### Approval-gate modality (v0.22)

The deferred-approval phrase (确认后再执行) is classified per clause
(`classifyApprovalRequirement`): a NEGATOR lifts any gate (不需要确认后
再执行 → none), quoted/hypothetical/advisory mentions are ignored (把
README 里的"确认后再执行"改成… / 如果确认后再执行会怎样 / 解释一下…),
and only a bare demand creates the gate. Precedence in chooseRigor:
`/policy off` > current-prompt explicit gate > pinned runtime mode >
risk routing — a stale /policy standard can never silence a gate the
user demands in the current prompt; the gate is lifted per-prompt by
saying so.

### Plan-response sequential resolution (v0.22)

classifyPlanResponse resolves clauses IN ORDER: a whole-CLAUSE cancel
(anchored — 先别动数据库 is scoped, not global) sets cancel; correction
heads (不对/等等/还是/actually…) reset everything and their remainder
becomes the new instruction; constraints (scoped rejection 不要执行第
二步, negated targets, contrast, added instructions) are STICKY revise —
later generic approval does not un-stick them, only a correction does.

## 5. Strict rigor state machine

`phase` is the single source of truth (the pre-0.15 `pendingApproval` boolean
described the same state with a second field and allowed invalid combos).

```text
idle
  ↓ strict task classified (mutate intent)
planning                ← model produces the plan this turn
  ↓ agent_end
awaiting_approval
  ├─ approve (pure) → executing
  ├─ revise         → planning (plan updated; re-approval required)
  ├─ discuss        → awaiting_approval (question answered)
  ├─ cancel         → idle
  └─ unknown        → awaiting_approval (+ explicit reminder injected)
executing
  ↓ agent_end
idle
```

Response routing lives in `src/core/approval.js::classifyPlanResponse` —
five-way classification with one core principle: **only a pure approval
releases execution**. Any constraint signal (但是/不过/只/先/不要改X/but/
only/except) makes the response a REVISE regardless of approval flavor.
Confirmed empirically before the fix: "批准，但是不要改数据库" used to
release execution as an approval.

A "verifying" phase (post-execution verification pass) is planned but
requires wave tracking that does not exist yet; executing currently
returns to idle at agent_end.

## 5a. Session-restart restore (v0.20)

awaiting_approval is persisted (minimal decision fields only) next to the
history file and restored on session_start — cwd-matched, max 7 days old.
Plan → quit → /resume → "批准" routes through the approval classifier
instead of fresh classification. /policy cancel discards. Concurrency:
two live sessions in one project share the file; last writer wins and
the failure direction is safe (asks again, never auto-releases).

## 6. No tool-call interception (v0.12)

Early versions shipped a mechanical gate (`soft`/`hard` tool_call blocking
while `pendingApproval` was set). That put this extension on the same layer as
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

**Future option (NOT in 1.0): `strictPhaseGuard`** — an opt-in
(default-off) invariant guard that blocks exactly `edit` / `write` /
`apply_patch` while `phase` is planning or awaiting_approval. It would
parse no Bash, judge no commands, and grant no permissions — pure
workflow-invariant enforcement, keeping this extension off the
permission layer. It stays unimplemented until field evidence shows
PLAN-ONLY instructions being ignored in practice.

`src/core/approval.js` is the only remnant of the old guard module, kept
because the strict state machine needs phrase recognition.

## 7. Project policy discovery

Project policies live at `.pi/policies/**/*.md`, discovered from cwd
**upward** to the enclosing git root (v0.18) — starting pi in
`repo/backend/service-a` now sees `repo/.pi/policies`. Nearest root wins
on duplicate relative ids (shadowing). Limits prevent unbounded growth:

- `projectPolicyMaxFiles` (default 12)
- `projectPolicyMaxBytes` (default 24000; participates in the unified
  policyMaxBytes budget via composeAllPolicies)
- `projectPolicies` allowlist (optional)

**Conditional loading (v0.18)**: when a `.pi/policies/manifest.json`
exists, only its listed entries load, each gated by optional
`tasks` / `domains` / `concerns` filters against the current decision
(no filters = always). Unlisted files do not load — a 30-file project
stays quiet.

## 7a. Task continuity (v0.18)

`agent_end` leaves the previous decision in state. A whole-message
follow-up ("继续" / "还是不对" / "按这个做" — see intent.js
FOLLOWUP_PATTERNS) carries no instructions of its own, so decide()
inherits taskType + domains from the last decision, recomputes
executionIntent (a live intent on the follow-up wins; unclear falls
back to the inherited one), and escalates risk ONLY when the follow-up
itself produced a `risk:` reason — the no-evidence default "medium"
never escalates a quick task to standard. Off-rigor or absent
lastDecision disables continuity. Every inheritance is recorded in
reasons as `task-continuity: ...` for /policy why.

## 7b. Config trust boundary (v0.21, dual-trust clarified in v0.22)

Project config layers (`.pi/policy-engine.json` upward to the git root)
follow a DUAL-TRUST model: trusted for routing/behavior customization
(mode, policy selection, budgets — a repo may carry its own conventions
exactly like project instructions), NEVER trusted with host credentials,
arbitrary network destinations, or arbitrary filesystem destinations.
`sanitizeProjectConfig` enforces the second half via an allowlist of
routing/noise keys; `semanticFallback`, `historyFile`,
`historyMaxEntries` — anything network / credential / filesystem — are
global-only and silently dropped at load (surfaced by /policy validate).
A verified exfiltration path (project-level fallback endpoint +
apiKeyEnvVar sending the env secret + full prompt as a Bearer request)
motivated this. Invalid VALUES are normalized at load time
(normalizeEffectiveConfig): unknown mode/profile → auto, non-numeric
byte/domain caps → defaults; validate consumes the RAW config so it
still diagnoses the actual mistakes.

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

Shows the last decision's full reasoning: rigor / flow / phase / task / risk /
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
├── lifecycle.js      # pi event handlers (no tool_call) + strict-rigor state machine
├── state.js          # createState + decide/preview/compareDecisions/validateConfig glue + history recording
├── format.js         # all command output formatters
└── helpers.js        # findPackageRoot / cleanModel / notify / setStatus / parsePolicyCommand

src/core/             # pure modules, no pi import dependency — testable in isolation
├── classifier.js     # rule-based task/risk/domain classification
├── router.js         # buildDecision (rigor + flow + profile + model policy via config/models.json)
├── loader.js         # loadManifest / loadProfile / loadProjectPolicies / composePolicies / renderPolicyBlock
├── approval.js       # classifyPlanResponse (approve/revise/discuss/cancel/unknown)
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
