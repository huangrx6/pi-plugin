# Design — pi-policy-engine 0.31.0

## Responsibility

The extension classifies user intent, selects task instructions, tracks bounded approval, and explains the exact injected text. It does not intercept tools, schedule workers, select the main model, or implement retrieval storage. Instructions remain a behavioral contract; snapshots prove delivery, not compliance.

## Turn pipeline

```text
input + current conversation
  → model preflight interpretation OR optional endpoint classification
  → authorization and intent
  → rigor, coverage, profile, current-model adaptation
  → required boundaries, optional policies and budget
  → injected instructions + transition record + session snapshot
```

`transitions.js::resolveTurn` owns the transition decision. `policy-block.js` composes and renders it. The lifecycle applies these functions to live state; preview applies them to a cloned state. Preview defaults to no semantic network call. `--new` discards current runtime/task context for the preview; `--semantic` permits the configured opt-in classifier.

Model preflight interpretation produces one authoritative relationship, task, intent, risk, domain and coverage result before the normal turn. The default agent source calls the host's active model through `modelRegistry.complete`, using a bounded conversation payload and no tools. The validated result selects the corresponding intent, flow, rigor, profile and domain policies. A host model failure or invalid result blocks the turn; it never silently routes through the old keyword rules. The deterministic path remains only for compatibility with hosts that do not expose the current-agent model API. Uncertainty cannot grant mutation or approval.

## Intent and authorization

Quoted examples are masked before intent and authorization parsing. Negated actions do not authorize mutation. Inspection requests can name mutation paths as objects: checking a database write pipeline remains read-only. A comprehensive review has a coverage dimension independent of mutation risk and uses at least standard depth in auto mode.

The low-level approval parser distinguishes approve, revise, discuss, cancel, and unknown. `resolvePlanResponse` additionally accepts explicit approval with a recognized narrowing or compatibility constraint. Those restrictions are retained with the task and re-injected on continuation. Other added work or plan replacement remains a revision. Autonomous execution is recognized only in a live affirmative instruction; it applies to the current task and is revoked by a fresh explicit approval requirement.

Each task has an ID, full original goal, user requirement records, extracted constraints with their source text, plan version, optional approved version, autonomy flag, and scope restrictions. Raw user requirements remain available even if constraint extraction misses a clause. These records are not an automatically reconciled constraint solver: later corrections must be interpreted in context; the classifier cannot erase history. A separate work decision preserves execution context across questions. New tasks cannot inherit the previous task's authorization. Approval of a version permits bounded continuation of that version. A revised plan increments its version. Reasons keep a bounded recent explanation instead of repeatedly embedding the entire previous history.

## Phases and outcomes

| Current phase | Event | Result |
| --- | --- | --- |
| idle | strict mutation without authorization | planning |
| planning | valid current-task/current-version `policy-plan` report with steps and verification | awaiting_approval |
| planning | no valid plan report or model error | planning, with missing_plan or failed/interrupted outcome |
| awaiting_approval | question / unrecognized response | remain awaiting_approval |
| awaiting_approval | plan revision | planning |
| awaiting_approval | approved version | executing |
| any active phase | explicit new task | classify independently |
| executing | normal round end | idle, outcome unverified |
| executing | error / abort | outcome failed / interrupted |

The `policy-plan` JSON report must bind taskId and planVersion and contain a nonempty goal and steps with action/verification strings. A request for a file path or plain text does not qualify. The stored evidence is explicitly assistant_reported; structural validity is not semantic proof that the plan is adequate. The engine has no authoritative verification-result protocol and never marks the task verified-complete merely from a round ending.

Mutation planning and awaiting approval both load `rigor.strict-plan`; only executing an authorized mutation loads `rigor.strict-execute`. A pinned strict read-only request uses `rigor.strict-review` without claiming implementation approval. A pending approval is not bypassed by a depth setting. The daily panel exposes automatic, strict and off presets; choosing one immediately writes the validated global user config. Legacy direct commands remain available for scripts and diagnostics but do not occupy the panel.

## Session and branch persistence

`policy-engine-workflow` custom entries contain version 3 workflow snapshots. They are not model messages. Restoration uses the current branch, same session ID and cwd, and a seven-day age limit. A waiting plan must reference an assistant entry still present in that branch; the parsed report must match the saved plan. Version 2 snapshots without a plan report downgrade to planning instead of retaining approval. A fork with a different session ID starts without inherited authorization. An executing snapshot restored after interruption becomes idle with an interrupted outcome.

Session-aware hosts without a branch API may use a disk fallback. The file name hashes cwd plus session ID. A host without session identity only maintains runtime/session entries and does not use a shared directory-only approval file. Legacy version 1 state is preserved but cannot restore approval for a version 2 runtime session.

Workflow writes use a temporary file and rename; clearing removes the matching state file. Lifecycle and command handlers await persistence and surface failures. The session snapshot is the primary source on normal Pi hosts. Global JSONL history remains diagnostic, uses best-effort appends and bounded rotation, and is not an authorization source.

## Diagnostics

Every live decision, including pending-plan responses, records relationship, intent, phase before/after, outcome, task/version/session, current model, recognition source/reason/model/latency, configuration fingerprint, injection fingerprint, actual injected bytes and a short prompt excerpt. Round end records its phase/outcome separately. The activity card retains the exact appended text and an immutable decision snapshot; identical injected text and phase do not produce duplicate activity cards.

The current snapshot keeps routing state. JSONL keeps diagnostic events. Neither is a vector database or a learned classifier. No operational state is inferred from semantic similarity.

## Configuration contract

Precedence: package defaults < global config < ancestor-to-nearest project configs < runtime mode/profile/recognition selection. `schema.js` validates types, arrays, enums, integer bounds, nested semantic settings and model rules. `/policy validate` adds policy-reference and file diagnostics. Effective config reports leaf-value sources.

On a runtime configuration error, the previous valid configuration for that cwd is retained and the error is shown. On first load, invalid values use normalized safe defaults, invalid semantic settings cannot initiate a network call, and diagnostics remain visible. Project settings cannot supply credentials, endpoints, history paths or global model rules.

The daily panel atomically saves automatic, strict and off selections to `<agent-dir>/extensions-data/pi-policy-engine/config.json`, preserving unrelated valid settings. It refuses to overwrite malformed JSON. Package `config/defaults.json` is immutable distribution data, not user state. The default agent directory is `~/.pi/agent`; `PI_CODING_AGENT_DIR` replaces that root.

Global `modelRules` precede package rules. Matching is exact provider plus exact or trailing-star model prefix, case insensitive. A proxy/provider alias can map to an existing model policy. The main model is always the host's choice. Agent source calls the active host model through the registry with no tools, session-message writes or recursive agent calls. Endpoint source supports OpenAI-compatible Chat Completions and Anthropic Messages, optional JSON response format and temperature, plus explicitly unauthenticated local services. Legacy fallback retains its single-prompt OpenAI-compatible conservative merge.

## Model interpretation boundary

For agent source, `interpretation.js` sends a bounded conversation and task snapshot to the active host model during Pi's `context` hook, after the user message has been emitted and the host Working row has started. `validateInterpretation` accepts only the declared route schema; the result is then used to select policies. The selected block is appended to the provider payload in `before_provider_request`, so it is sent to the model without becoming a synthetic session message. `setWorkingMessage` labels the host-owned spinner during preflight. For endpoint source, the module serializes the latest message, goal, retained requirements/constraints, plan and phase into a bounded data-only request. The global-only endpoint and environment-variable reference form the network trust boundary. Existing source-less semantic configurations preserve endpoint behavior.

Primary results must have exactly the specified fields, valid task/relation/intent/risk/coverage enums, known domains and bounded constraint quotations present in unquoted current user text. Extra authorization fields invalidate the response. The model can correct rule classification, but cannot write task IDs, approved versions or autonomy. Direct user approval requirements remain authoritative. Natural-language approvals still use the conservative local parser; `/policy approve` is the explicit alternative. Risk cannot decrease during a continuing task; architecture retains its high-risk floor. A model's result has no fabricated confidence probability.

For endpoint source, the deadline covers transport and JSON parsing even when an injected transport ignores abort. HTTP errors, malformed JSON/schema, missing keys and network failure return diagnostic codes without response bodies or secrets. Oversized serialized context falls back without silently dropping constraints. No retries occur. Agent source and ordinary offline previews make no network call. Legacy fallback does not supply contextual task relation.

The classification result remains fallible, and injected behavior does not enforce tool permissions. Mock protocol tests establish data flow and transition invariants, not model accuracy. Real-model evaluation must measure task misassociation, constraint retention, false approval waits, latency/cost and outcomes before enabling classification by default or claiming provider-specific prompt efficacy.

## Policy composition

Required intent and strict-phase policies precede core and project material. Remaining ordering is flow, comprehensive coverage, rigor, concerns, domains, profile behaviors and model adaptation. Entries are whole semantic units under one policy-content byte budget. The final output adds framing, diagnostics and task contract and plan reporting instructions; actual injected bytes are measured separately.

If required policies are missing, excluded or cannot fit, the turn is marked blocked and receives an explicit instruction not to implement changes. No tool interception is added. Arbitrary contradictory project prose cannot be mechanically proven consistent; controlled built-in phase conflicts are covered by tests.

## Validation and upgrade

Tests use OS temporary directories. The smoke entry point isolates both cwd and `PI_CODING_AGENT_DIR`; asynchronous writes complete before cleanup. Regression scenarios include greetings, fresh reviews after pending debugging, negated/quoted autonomy, narrowing approvals, restart/fork/tree navigation, missing plans, errors, model changes, damaged configuration, preview parity and insufficient budgets.

Version 0.31.0 moves current-agent recognition into Pi's message-first `context` lifecycle and uses the built-in Working spinner for feedback. Existing history stays readable, and endpoint configurations remain compatible. Updating the installed package and reloading Pi are separate deployment actions from changing this repository.
