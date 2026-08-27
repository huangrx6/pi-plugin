<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/policy-engine.svg" alt="pi-policy-engine" width="48" />
</p>

# pi-policy-engine

<p align="center"><strong>Adaptive workflow routing: quick / standard / strict, with plan-then-approve for risky work.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

Inject "strict process" instructions into the system prompt based on what the task looks like. The model reads them, follows them, and stops on its own — exactly how a skill would say "here you must pause and ask the user".

This extension acts only at the task-behavior layer (system-prompt injection + flow state machine). It does not intercept `tool_call`; any tool-permission question belongs to a permission extension, not this one.

## What it does

When a prompt arrives:

1. **Classifier** (deterministic rules, no LLM call) decides risk → rigor
2. **`before_agent_start`** injects the matched policies into the system prompt
3. Under `strict`, the injected policy says verbatim: "This turn is PLAN-ONLY. … Stop after the plan and ask for approval. Do not start implementation in the same turn."
4. The model, having read that, returns a Task Contract + Constraint Ledger + plan, then stops without issuing any tool call
5. When you reply "开始执行" / "approve" / "go ahead", `before_agent_start` detects the approval, transitions phase from `planning` → `executing`, and injects `strict-execute` instead

Mid-plan follow-up questions ("为什么第二步要这样做？") are not approval; the state machine stays in `planning` and appends "do not execute until explicit approval".

This is **soft constraint**: the extension injects instructions; the model obeys them. If a model decides to ignore `PLAN-ONLY` and starts writing files, this extension will not stop it — that's a permission-layer concern, deliberately out of scope.

## Quick example

Prompt: `设计生产环境 PostgreSQL schema 迁移方案并实施`

```text
# Active Policy Runtime
Rigor: strict
Phase: planning

## Policy: rigor.strict-plan
This turn is PLAN-ONLY. Do not mutate files, configuration, infrastructure,
or external state. Produce a concise but explicit Task Contract and
Constraint Ledger. ... Stop after the plan and ask for approval. Do not
start implementation in the same turn.
```

The model returns a plan and stops. You reply `开始执行`, the state transitions, `strict-execute` is injected, and the model executes in waves.

## Rigor vs Flow

```text
prompt enters
   ↓
Classifier (deterministic, no LLM)
   ↓ task / risk / domain / concern / model / user override
   ↓
Policy Router
   ├─ Rigor (how strict)
   │    risk high → strict (plan + pause + waves)
   │    risk low  → quick
   │    else      → standard
   └─ Flow (how, by task type)
        debugging → debug-first
        review    → review-first
        research  → research-first
```

The two are orthogonal: `debug-first + quick`, `debug-first + strict` both legal. Before v0.19, flow was bolted into profile, which created special cases like "if profile carries flow, do not inject workflow policy" — now flow is derived from task type directly, and profile only carries behavioral constraints.

Why deterministic and not LLM-based classification? **Letting the model decide what constraints to put on itself is circular.** Rule routing is fast, auditable, and immune to model drift.

## Domain denoising

Early versions took any keyword hit as a load: one `组件` loaded the entire frontend policy; one `权限` loaded security. Before the model even started, 13 rules had been pushed into its context. **This extension exists to reduce context noise; it must not generate noise.**

The rules now:

- Domain keywords split into **strong / weak**: strong (`postgres`, `react`, `jwt`, `kubectl`, …) loads on hit; weak (`组件`, `api`, `权限`, `sql`, …) alone does not load — needs two weak signals in the same domain, or a frame term (`React` + `组件`)
- Triggered domains sort by score; only top `maxDomains` (default 2) load; rest are pruned with the reason recorded in `/policy why`
- **Domain vs Concern separation (v0.18)**: Domain answers "where the problem is" (database / backend); Concern answers "what extra care" (security / production). Concerns **do not** consume the `maxDomains` budget — `postgresql schema + spring controller + jwt 鉴权` loads database + backend (domains) and security (concern) without dropping security
- Confidence reflects candidate dispersion: tied candidates actively lower confidence (max -0.35); dominant winners unaffected — no more "three candidates tied at 0.95" false numbers

Every prune / down-weight decision shows up in `/policy why` for audit:

```text
domain:backend dropped (weak-only: 接口 (score 0.5 < 1, needs a frame term or a second signal))
concern:security dropped (weak-only: 密钥 (score 0.5 < 1, needs a frame term or a second signal))
confidence penalized: candidates dispersed (top=6, runner-up=6, dominance=0.00)
```

## Approval is a soft constraint

Strict's plan approval is **not** tool interception — it is the model's own instructions:

- Planning phase injects `strict-plan`: "This turn is PLAN-ONLY. Do not mutate … Stop after the plan and ask for approval."
- Model obeys → outputs plan and stops, awaiting approval (no write tools are issued, so nothing needs to be intercepted)
- You reply with an approval phrase (`执行` / `开始执行` / `批准` / `通过` / `可以执行` / `continue` / `approve` / `proceed` / `go ahead` / `do it`) → `before_agent_start` detects it, switches to `executing`, injects `strict-execute`
- Non-approval follow-up questions ("为什么第二步要这样做？") → state stays `planning`, "do not execute until explicit approval" is appended — no accidental downgrade

Deliberate non-feature: vague phrasing like "差不多就改吧" or "好像可以" is **not** recognised as approval — avoids accidental bypass.

## Execution intent: read-only / mutate / unclear

Every prompt is also classified into a three-value **execution intent**, surfaced in `/policy why`:

| Intent | Heuristic | Example |
| --- | --- | --- |
| `mutate` | Any modify-verb present and not negated | 帮我**修复**这个 bug / **优化**性能 |
| `read-only` | Only read-verbs, no modify-verbs | 只**分析**，不要修改 / **排查**为什么返回旧数据 |
| `unclear` | Vague or no verb | 帮我**看看**这个 / 继续 |

Key rules:

- **Negation scope**: verbs inside a negation window are dead evidence; "不要只分析，直接修改代码" = `mutate` (the old `analysisOnly` rule misclassified this)
- **Mention is not intent**: "迁移**方案**的风险" / "README 里**写了**什么" are mentions, not requests — Intent beats mention
- `read-only` automatically downgrades `strict` to `standard/quick` (pure reading needs no approval loop); `unclear` keeps the full strictness
- If the semantic fallback does not explicitly assert an intent, the deterministic result is preserved

## Strict plan survives session resume (v0.20)

A pending strict plan no longer gets lost when you exit Pi or `/resume` an old session: the `awaiting` state and minimal decision are persisted alongside the history file, restored on `session_start` (same project dir match, ≤ 7 days; `/policy cancel` discards). "Generate a plan at night, /resume next morning, approve" now flows through the approval classifier correctly. Persisted state is sharded by project-directory hash (`strict-state-<hash>.json`) so different projects never overwrite each other; two sessions of the same project share the file — last writer wins, and the failure direction is safe (re-asks rather than auto-clearing).

## Execution timing & explicit approval (v0.21)

Two internal dimensions beyond execution intent: **execution timing** (`now` / `deferred`) and **approval requirement** (`explicit` / `none`). When you say "确认后再执行 / 等我批准", explicit approval **overrides** automatic risk judgement — it forces strict's plan → pause → execute flow regardless of what `risk` calculated.

## Project trust boundary (v0.21)

The project-level `.pi/policy-engine.json` uses a **dual-trust model**: routing and behavioural customisation (mode, policy selection, budget — a repo carrying its own conventions is reasonable) **is** trusted; host credentials, arbitrary network destinations, arbitrary filesystem destinations **are not**. So the project layer may carry routing / denoise config, but `semanticFallback` (which can point at any endpoint + any env var), `historyFile`, `historyMaxEntries`, and other network / credential / filesystem-privileged keys are **global-only** (~/.pi/agent/policy-engine.json). Project-layer attempts to write privileged keys are silently dropped; `/policy validate` reports them as "global-only, ignored".

Invalid config values also fall back to defaults at runtime (`maxDomains: "oops"` no longer disables the cap); `/policy validate` reports them in addition.

## Task continuity (v0.18)

After a turn ends (`agent_end`), users often send short follow-ups with no new instruction: `继续` / `还是不对` / `再看看` / `按这个做`. These prompts carry nothing the classifier can latch onto, so they re-classify as `coding / medium / no-domain` and the model loses the previous turn's constraints.

Now a follow-up prompt (no comma-introduced new instruction) inherits the previous turn's **task**, **domains**, and **concerns** ("继续" no longer drops the security concern), recomputes execution intent (new intent wins; no signal = inherited), and only raises risk when the follow-up itself carries real risk evidence (a production keyword appearing in `继续修一下生产那个`). Follow-ups also classify by type: **executive** (`按这个做` / `继续修` / `do it`) flips the previous read-only recommendation to mutate; **neutral** (`继续` / `还是不对`) inherits the previous intent.

## Debug commands

| Command | Purpose |
| --- | --- |
| `/policy` | Interactive selector (mode / profile) |
| `/policy auto\|quick\|standard\|strict\|off` | Switch runtime mode |
| `/policy once <mode>` | Use `<mode>` for the next turn only |
| `/policy profile <name>` | Switch profile (`auto` / `coding` / `debugging` / `documentation` / `architecture` / `review` / `research`) |
| `/policy preview <prompt>` | Dry-run the routing without sending to the agent |
| `/policy diff <promptA> \|\| <promptB>` | Compare routing decisions for two prompts |
| `/policy history [N\|clear-disk]` | Last N routing decisions (default 5); `clear-disk` wipes the JSONL history file |
| `/policy config` | Print the resolved config (defaults + global + project + runtime override merged) |
| `/policy validate` | Validate config: manifest paths / profile references / include-exclude references |
| `/policy status` | Current mode / profile / phase / model |
| `/policy why` | Last turn's full routing decision, including which rules hit |
| `/policy cancel` | Cancel a pending strict plan |
| `/policy reset` | Clear all runtime overrides |

### Preview output

```text
# Policy preview (dry run; nothing is executed)

task: architecture
risk: high
confidence: 0.9
domains: database, kubernetes
rigor: strict
phase: planning
profile: architecture
model policy: model.minimax-m3
would require approval: yes

built-in policies (8 loaded, 3542 bytes / 24000 budget = 14%):
  - core.evidence-priority
  - core.constraint-retention
  - ...
truncated by byte budget:
  - (none)

project policies (0 loaded, 0 bytes):
  - (none)
```

Preview is pure read — no session state change, no agent call, no fallback call.

### Diff output

```text
# Policy diff

LEFT : 修一个 PG migration bug
RIGHT: 改 README typo

LEFT
  rigor: strict
  task / risk: architecture / high
  ...
RIGHT
  rigor: quick
  task / risk: documentation / low
  ...

Differences (4):
  rigor: strict  →  quick
  task: architecture  →  documentation
  risk: high  →  low
  would require approval: yes  →  no
```

Separator is `||` (no spaces needed on either side).

## Configuration

### Precedence

```text
package defaults
  ↓
~/.pi/agent/policy-engine.json     ← user-global
  ↓
<project>/.pi/policy-engine.json   ← project-level
  ↓
runtime /policy override           ← process-local (/policy command)
```

### Global example

```json
{
  "mode": "auto",
  "profile": "auto",
  "showStatus": true,
  "includePolicies": ["behavior.execution-discipline"],
  "excludePolicies": [],
  "domainHints": ["backend"],
  "projectPolicyMaxFiles": 12,
  "projectPolicyMaxBytes": 24000,
  "historyFile": "~/.pi/agent/policy-engine/history.jsonl",
  "historyMaxEntries": 500
}
```

### Project example

`.pi/policy-engine.json`:

```json
{
  "mode": "auto",
  "profile": "auto",
  "domainHints": ["backend"],
  "projectPolicies": ["compatibility.md"]
}
```

Without `projectPolicies`, scans `.pi/policies/**/*.md` automatically (capped at 12 files / 24 KB by default).

With multiple policy files, an opt-in `manifest.json` enables conditional loading — only entries relevant to the current decision load, others are skipped. Filter semantics are **AND across dimensions, OR within**:

```json
{
  "db-migration": { "path": "database-migration.md", "tasks": ["architecture"], "domains": ["database"] },
  "always": { "path": "team-conventions.md" }
}
```

`db-migration` loads only when `task ∈ {architecture}` **and** `domains` contains `database`. Manifest `path` values may only reference files inside `.pi/policies/` (symlink-validated); out-of-tree paths are rejected and recorded in `/policy why`.

```text
my-project/
└── .pi/
    ├── policy-engine.json
    └── policies/
        ├── manifest.json
        ├── compatibility.md
        └── architecture.md
```

### Optional: semantic fallback

If the v0.x deterministic classifier ever feels brittle on cryptic prompts, optionally enable an OpenAI-compatible semantic re-classifier as a fallback:

- **Default off** — needs network + API key, opt in
- Only fires when deterministic `confidence < confidenceThreshold` (default 0.7)
- Any failure (timeout / network / schema mismatch) → silent fallback to deterministic result, **never blocks the agent**
- When enabled, you will see `semantic-fallback: …` in `decision.reasons`; verify with `/policy why`

```json
{
  "semanticFallback": {
    "enabled": true,
    "endpoint": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4o-mini",
    "apiKeyEnvVar": "OPENAI_API_KEY",
    "confidenceThreshold": 0.7,
    "timeoutMs": 4000
  }
}
```

The API key is read by **environment variable name** (`apiKeyEnvVar`), not stored in the config. To switch provider, change `endpoint` + `model` + `apiKeyEnvVar` — not limited to OpenAI.

## Custom policies

Add a globally reusable policy:

1. Write `policies/<layer>/<name>.md`
2. Register `id → path` in `policies/manifest.json`
3. Add to a `profiles/<name>.json`'s `policies` array, or enable via `includePolicies`

Add a project-scoped policy: drop it in `.pi/policies/<name>.md` — **no manifest change needed**.

Extend routing keywords: edit `config/routing.json`'s `taskRules / domainRules / highRisk / mediumRisk` — pure data-driven, no classifier code changes.

## Boundaries

```text
AGENTS.md          = small, always-on project / global constitution
Skill              = how to do a specific capability (DB migration, drawing, …)
pi-policy-engine   = dynamic behavior rules + rigor/flow routing + model / domain / concern adaptation
```

This extension does not replace AGENTS.md or Skills, and does not assume either exists.

## Known limitations

- V0.x classifier is rule-based, not a semantic model. Optional `semanticFallback` (OpenAI-compatible HTTP) re-classifies via a small LLM when deterministic confidence is low. Off by default; any failure falls back deterministically. Needs API key + network; not suitable for offline scenarios.
- **Strict approval is soft constraint (task behavior layer)**: the model is told "PLAN-ONLY, pause for approval" — it is not mechanically blocked. If the model ignores the instruction, the safety net is whatever permission extension you happen to run.
- `/policy` runtime override is process-local; persist via global / project `policy-engine.json`
- Strict approval requires an explicit approval phrase (whitelisted); vague phrases are deliberately ignored to avoid accidental bypass

## File structure

```text
pi-policy-engine/
├── extensions/policy-engine/
│   └── index.js                  # Pi extension entry
├── src/core/                     # pure logic (no pi imports; independently testable)
│   ├── classifier.js             # rule-based task / risk / domain classifier
│   ├── router.js                 # classification → decision
│   ├── loader.js                 # load policies + byte budget
│   ├── approval.js               # approval-phrase recognition (strict state machine)
│   ├── config.js                 # four-layer config merge
│   ├── semantic.js               # optional semantic fallback
│   └── history-store.js          # routing-history JSONL persistence
├── policies/                     # Markdown policies
│   ├── core/ behaviors/ flows/ rigors/ domains/ concerns/ models/
│   └── manifest.json             # global policy registry
├── profiles/                     # profile JSONs (policy combinations)
├── config/
│   ├── defaults.json
│   └── routing.json              # routing keywords (data-driven)
├── examples/                     # small trial runs
├── scripts/                      # smoke-extension (lifecycle smoke)
└── tests/                        # node:test unit + regression-corpus.json
```

## License

MIT © huangrx6
