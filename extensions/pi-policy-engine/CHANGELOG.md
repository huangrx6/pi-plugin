# Changelog

## 0.31.0 - 2026-09-05

- Move model-first intent recognition into Pi's `context` lifecycle hook so the user message is rendered immediately and the host-owned Working spinner is active during preflight.
- Use `setWorkingMessage("意图识别中…")` for the preflight label, then restore Pi's normal Working text after the policy is selected.
- Inject the selected policy into the provider payload immediately before the request, without persisting a synthetic chat message or blocking the user message render.
- Support common Pi provider payload shapes (`messages`, `system`, and `instructions`) with idempotent injection.
- Keep a compatibility path for older hosts without `setWorkingMessage`; current Pi versions use the message-first lifecycle.

## 0.30.0 - 2026-09-05

- 当前 agent 改为前置结构化意图识别：先识别任务关系、任务类型、执行意图、风险、领域和覆盖范围，再选择对应策略。
- 识别期间通过 Pi 状态栏显示“意图识别中…”，识别完成后显示已选择的轻量、标准或严格流程。
- 识别请求复用当前模型和宿主认证，携带有界的当前对话与任务快照，不提供工具，也不能自行授予审批权限。
- 识别失败、超时或输出不合法时显示失败状态并阻断策略执行；宿主没有模型注册表时才保留旧规则作为兼容路径。

## 0.29.0 - 2026-09-05

- 当前 agent 识别改为同一轮回答内完成，不再在 `before_agent_start` 中额外调用一次模型；消除消息显示前约 5 秒的阻塞，并让模型直接使用完整对话理解“继续”。
- 新增 `intent.contextual` 策略；规则标签只用于选择基础策略，活动卡片显示“当前模型结合对话处理”，不再把缺少插件任务快照的续作写成“意图待明确”。
- `/policy` 改为一级日常面板，只保留查看状态、自动处理、谨慎处理、当前计划审批/结束当前任务、检查配置和关闭策略；删除面板中的单次模式、配置档、独立保存和多层诊断入口。
- 选择自动、谨慎或关闭后立即原子保存到全局用户配置，不再要求再执行一次保存命令；检查配置会显示实际个人配置路径。
- 默认启用当前 agent 的同轮上下文理解，不需要接口、模型或密钥配置；独立 endpoint 仅保留为高级全局配置能力。
- 内置默认配置不再携带未使用的 OpenAI endpoint、模型和密钥变量，避免误以为当前 agent 模式依赖这些值。
- 修正配置边界测试，使其显式隔离用户全局配置，避免真实 `config.json` 改变测试结果。

## 0.28.0 - 2026-09-05

- `/policy` 增加分组选择面板，覆盖任务账本与审批、模式、单次模式、意图识别、配置档、全局/项目保存以及常用只读诊断；选项内注明效果、调用成本和持久化边界。
- 增加内置命令说明面板，列出需要输入参数的 preview、diff 等命令和注意事项。
- 新增 `/policy recognition agent`：通过当前 Pi 的 modelRegistry.complete 复用活动模型及宿主认证，无需额外 endpoint、模型名或 API Key；下一轮跟随主模型切换。
- `/policy recognition endpoint` 保留独立识别服务；老配置保持原来的接口来源，新配置默认识别来源为 agent，仍需显式开启。
- 当前模型识别与语义预览共用结构校验、上下文预算和超时控制；宿主接口不可用时显示原因并降为规则，不偷偷切换服务。
- 新配置请求时限为 15 秒；旧接口配置保留原时限或旧默认 4 秒。增加宿主模型切换、离线预览、无凭证复用及降级回归。

## 0.27.0 - 2026-09-05

- 增加带任务上下文的大模型优先识别，统一任务关系、意图、领域与覆盖范围；旧低置信度回退模式保持兼容，默认仍离线。
- 支持 OpenAI Chat Completions 兼容接口、Anthropic Messages 及无密钥本地接口；模型输出校验、请求截止时间与可诊断降级，不自动重试。
- 修复长句续作重新建任务导致约束与授权丢失；保存完整目标、用户要求原文和约束来源，修订使旧计划授权失效。
- 待审批必须有绑定任务 ID / 版本并包含步骤与验证项的结构化计划；普通回复不再充当计划，分支恢复核对实际计划内容。
- 新增 `/policy recognition primary|fallback|off`、`/policy task`、`/policy new`、`/policy approve`；识别选择可保存到全局配置。
- 预览和历史记录识别来源、降级原因与延迟；模型输出不能自行授予执行权限，规则分值不再冒充模型置信度。
- 工作流快照升级为版本 3，旧版无计划证据的审批降为规划状态；补充多轮、接口协议、超时与错误响应回归。

## 0.26.0 - 2026-09-05

- 新任务、计划回复和普通对话先分流；全面审查采用只读覆盖流程，旧排障计划不再接管新的审查请求。
- 修复否定、引用、问句中的自主授权误判及“检查写入链路”被识别为修改的问题；显式批准附带可识别的范围限制时保留限制并执行。
- 等待批准阶段统一使用计划策略；授权绑定任务和计划版本，跨任务不继承。
- 增加会话分支工作流快照、会话隔离的原子状态保存、阶段事件记录及未验证/失败/中断结果；旧目录级审批状态不自动升级为新会话授权。
- 当前上下文预览与执行共用决策和策略组合；默认不联网，支持 `--new` 与显式 `--semantic`。
- 统一配置结构校验，显示来源，配置损坏时保留运行中最后有效配置；支持 `/policy save global|project` 保存已选模式与配置档。
- 开放全局 `modelRules`，支持代理平台和模型别名；辅助分类可关闭 JSON response_format 或省略 temperature。
- 优先保留意图与阶段策略，关键策略无法加载时追加禁止执行说明；区分策略正文预算与实际注入字节。
- 隔离冒烟测试 agent 数据目录，等待持久化完成；增加真实表达、多轮切换、恢复、配置和模型适配回归测试。

## 0.25.2 - 2026-09-04

- 全局配置统一为 `extensions-data/pi-policy-engine/config.json`，路由历史与未决严格计划统一保存在 `state/`；支持 `PI_CODING_AGENT_DIR`。
- 新路径尚未建立时继续读取旧配置与旧状态目录；显式指定的 `historyFile` 保持优先，运行时不自动搬移文件。

## 0.25.1 - 2026-09-04

- 为策略历史卡片增加主题层级：摘要、正文、警告和辅助说明分别使用宿主主题角色，并按中文、emoji 和组合字符的实际显示宽度换行。
- 所有策略命令通知和历史渲染在展示前移除终端控制序列与双向文本控制字符；异常历史记录安全降级。
- 历史快照及其嵌套决策冻结，恢复后仍保持不可变；设置菜单将模式与配置档拆成独立操作，取消不产生消息。

## 0.25.0 - 2026-09-04

- 在对话中记录实际策略注入：原因、已加载要求、未注入项与当时的安排；展开查看详情，相同注入不重复刷屏。
- `/policy` 默认查看本次行为和当前流程；设置移入次级入口，`/policy injected` 查看实际追加原文。
- 记录为不参与模型上下文的会话条目，历史说明不会随新决策改变；旧运行时退化为简短提示。

## 0.24.0

### Autonomy grants release the strict approval gate

**The bug (verified live, 2026-09-03):** the user's go-to-bed message —
"…构思完就执行，不用征求我的意见了" — was classified REVISE, so the
engine kept demanding plan approval while the user slept. Two causes:

1. "构思完就执行" contains the approval phrase 执行 with substantive
   leftover → approval flavor + content = revise (correct per v0.23
   semantics, wrong for this intent).
2. Nothing lifted the gate because 询问/意见/请示 were not approval
   vocabulary — `APPROVAL_NEGATOR_RE` only knew 确认/批准/同意/点头.

**Fixes:**

- `approval.js` — new exported `AUTONOMY_GRANT_RE` (中/英授权短语:
  不用征求我的意见 / 不用询问我 / 别问我了 / 自己决定 / 全权处理 /
  不用停下来 / don't ask me / keep going …). In
  `classifyPlanResponse` a grant clause → `approve` AND releases the
  rest of the message: riding constraints (“…但别动数据库”) become
  execution constraints instead of re-locking the gate; only a
  whole-clause cancel or a correction head (不对/等等…) revokes the
  release. Precision is guarded — "别问问题" and "自己写个方案" do NOT
  match (a false release is worse than a missed one).
- `intent.js` — `APPROVAL_NEGATOR_RE` object list grows
  询问/请示/问我/征求…意见 + EN ask-me forms, so
  "给方案，确认后再执行，不用征求我的意见了" lifts its own explicit
  gate instead of re-arming it.
- `lifecycle.js` — the approve branch now MERGES revision evidence when
  the approval carries content (grant + constraints, scoped
  approvals): risk only up, domains/concerns union — identical to the
  revise merge, but the phase enters `executing`. When an autonomy
  grant is present the Approved block states it explicitly:
  do-not-pause-for-approval guidance is injected.

### Strict-state hygiene

`pruneStrictStates` (history-store.js): every cwd gets a
`strict-state-<hash>.json` and nothing ever removed them (20+ stale
files accumulated next to the history). session_start now prunes
strict-state files older than 14 days. Best-effort; never throws.

New tests: live-message regression, grant vocabulary, grant+constraint,
grant+question, no-false-release precision, cancel/correction revocation,
gate-lift meta, prune round-trip (all fixtures under `os.tmpdir()`).

## 0.23.1 - 2026-08-27

- Fix the `/policy` interactive picker rendering one glyph per row: the option labels were `join("\n")`-ed into a single string before being passed to `ctx.ui.select`, whose widget iterates the argument per option — a string iterates per character. `selectOptionLabel` now returns a proper `string[]` (one label per option), and the stray third `options` argument to `select` was dropped.

## 0.23.0

Release-candidate hardening #4 — the three runtime invariants.

- **P0: read-only intent is BINDING in the policy runtime.** The classifier
  said read-only, then rigor.quick injected "Inspect -> Change -> Verify"
  and rigor.standard "execute it without unnecessary ceremony" — a direct
  system-prompt contradiction for "只分析这个 bug，不要修改代码". New
  intent policy layer (policies/intents/{read-only,mutate,unclear}.md,
  priority core > project > intent > flow > rigor > …); rigor.quick/
  standard and flow.debug-first are now intent-NEUTRAL (mutation guidance
  only inside "If mutation is requested:", plus an explicit read-only
  branch); the runtime header announces Execution intent / Execution
  timing / Approval required. Intent is a hard boundary; rigor decides
  depth, never whether to mutate.
- **P0: only a PURE approval releases — no enumeration gaps.** Verified
  leaks: "批准，不要重构/不要部署/不要迁移数据库/我还有一个要求/顺序别变"
  all approved (constraint verbs outside the enumerated lists), and
  "批准，为什么第二步要改数据库？" approved because a question could not
  override an earlier approve. Resolution is now conservative by default:
  approve + question → discuss; approve + ANY substantive clause → revise;
  only filler/continuation keeps the release.
- **P0: cancelled strict plans no longer revive.** v0.22 namespaced the
  state file but three clear sites (clearAwaitState, /policy cancel,
  /policy reset) kept the legacy un-namespaced call — they cleared
  strict-state.json while saves went to `strict-state-<hash>.json`, so a
  cancelled plan restored on restart. All save/load/clear paths now go
  through resolveStrictStatePath(cfg, cwd); E2E cancel → restart →
  no-restore is pinned.
- **P1: conditional execution ≠ hypothetical.** Bare 如果 no longer
  triggers hypothetical (comma-free "如果测试通过就部署" misread as
  read-only while the comma'd form mutated); the trigger is a consequence
  QUESTION (会发生什么/有什么影响/为什么要…). Conditional approval talk
  ("如果确认后再执行" + question clause) reads read-only consistently.
- **P1: specific negated verbs are scope constraints.** 不要重构/不要部署/
  不要删除 on an otherwise-live task stay mutate ("修复这个 bug，但不要
  重构" was unclear — 重构 has no target noun so it parsed as a global
  revoke). Only broad verbs (改/修改/动/做/执行…) revoke globally.
- **P1: quote-aware approval spans.** Matching now happens on unquoted
  text (quoted spans masked): '确认后再执行，字段叫"id"' gates; a quote
  elsewhere in the clause no longer hides the demand (the v0.22
  whole-clause skip made '先把标题改成"foo"' punctuation-sensitive).
- **P2**: global config (~/.pi/agent/policy-engine.json) parse errors are
  reported by /policy validate (project layers already were).
- Tests 181 → 183 (incl. runtime-invariant E2Es); corpus 58 → 71.

## 0.22.0

Release-candidate hardening #3 — approval-gate modality + sequential
plan-response resolution. No architecture changes.

- **P0: approval-gate modality.** The deferred-approval phrase was a bare
  whole-prompt regex: "不需要确认后再执行，直接修改代码" still created a
  gate (the user lifted it), and 把 README 里的"确认后再执行"改成"确认
  后部署" — a doc edit — sent a low-risk task to strict. New
  classifyApprovalRequirement resolves per clause: negators LIFT the
  gate, quoted/hypothetical/advisory mentions are ignored, only a bare
  demand gates. English negation ("no need to wait for my approval")
  included.
- **P0: current-prompt gate outranks pinned runtime mode.** /policy
  quick|standard used to swallow an explicit "确认后再执行" in the
  current prompt. Precedence is now: /policy off > explicit gate >
  pinned mode > risk routing. Lifting the gate per prompt (不用等我
  确认) restores the pinned mode.
- **Hypothetical mutations read as read-only**: "执行这个命令会发生
  什么？" / "删除这个文件会有什么影响？" / "如果修改生产数据库 schema
  会怎样？" were mutate (→ strict for the last one). A hypothetical
  marker sharing the clause with the verb (如果/会发生什么/有什么影响/
  为什么要/what happens if…) downgrades it to a question; markers in
  OTHER clauses stay live ("如果测试通过，就部署" still mutates).
- **Plan responses resolve sequentially**: "批准，但先别动数据库，其他
  按计划执行" cancelled the whole plan (unanchored CANCEL_RE); "算了，
  还是按原计划执行" also cancelled (no last-instruction logic). Now:
  whole-CLAUSE cancel only (先别动数据库 = scoped), correction heads
  reset and their remainder wins, constraints are sticky revise. EN
  scoped rejection ("hold off on database changes, proceed with the
  rest") and dash-splits ("cancel the plan—actually, go ahead" →
  approve) handled.
- **Revision merge unified** (mergeRevisionDecision): honors the
  effective config (maxDomains — a maxDomains:1 session no longer grows
  to 2 on revision; domainHints) and handles task REPLACEMENT
  ("不实施了，改成只更新 README" / "不要执行了，改成只分析风险" re-routes
  the task fresh, keeps the previous risk floor, still strict +
  awaiting approval). The lifecycle inline copy is gone.
- **Model routing structured**: exact provider + exact-or-glob model
  (trailing *). The substring rules loaded MiniMax-M30 with the M3
  policy and matched notdeepseek as deepseek (verified). Legacy
  {match:[...]} arrays are rejected at load.
- Trust-boundary docs clarified to the dual-trust model: project config
  is trusted for routing/behavior customization, NEVER trusted with
  credentials/network/filesystem.
- Regression corpus 45 → 58 (13 new: gate modality ×3, hypothetical ×5,
  plan-response ×5); routing tests pin gate-vs-pinned-mode precedence
  and the structured matcher.

## 0.21.0

Release-candidate hardening #2 — trust boundary + explicit approval gate.

- **P0 security: config trust boundary.** A project's .pi/policy-engine.json
  is untrusted input (any cloned repo ships one); it could previously set
  semanticFallback to an arbitrary endpoint + apiKeyEnvVar — verified
  exfiltration of the env secret as a Bearer token together with the full
  prompt — and historyFile to append JSONL to arbitrary user files
  (~/.zshrc). Project layers now pass through sanitizeProjectConfig: only
  routing/noise keys are accepted; semanticFallback, historyFile,
  historyMaxEntries (and any future network/credential/filesystem keys)
  are global-only and dropped. /policy validate reports ignored
  privileged keys explicitly.
- **P0 semantics: explicit approval gate.** "先别改，给我方案，确认后再
  执行" routed standard (mutate/medium) — the user's explicit
  confirm-before-execute never formed a gate. New execution meta:
  executionTiming (now/deferred) + approvalRequired (explicit). An
  explicit gate outranks risk heuristics → strict planning phase.
  Exposed via extractExecutionMeta; classification and decisions carry
  the fields; /policy why shows the reason.
- **Planning deliverables are read-only**: 设计/规划/制定/给我方案
  requests default to read-only (the plan IS the product); an
  implementation marker in the same clause (并实施/并实现/apply it)
  keeps it a mutation task. "帮我设计一个微服务迁移方案" →
  architecture/high/read-only/standard (was strict PLAN-ONLY for a
  deliverable nobody asked to execute).
- **Scoped negation**: "修复 bug，但不要改数据库" stays mutate — a
  negated verb with an attached target is a scope constraint, not a
  global revocation; bare negation ("不要修改") still revokes.
  Pronouns/quantifiers (任何/all/it) count as bare.
- **Semantic merge hardened**: honors config.maxDomains (was hardcoded
  ≥2) and re-applies task risk invariants post-merge (semantic
  coding→architecture with risk medium now lands high, like the
  deterministic classifier itself).
- **Strict state namespaced per project**: strict-state.json is now
  `strict-state-<sha256(cwd)[:16]>.json` — with the shared default history file,
  the last project to save stole every other project's restore
  (verified A/B). Legacy modelPolicy fields are stripped on restore.
- **modelPolicy recomputed per use**: no longer persisted; a plan drafted
  under MiniMax-M3 and approved after /model deepseek gets the DeepSeek
  adaptation (E2E-tested).
- **Runtime config normalization**: invalid values fall back to defaults
  at load time — maxDomains "oops" (NaN cap → four domains loaded),
  policyMaxBytes "oops" (fail-open budget), unknown profile (silently
  dropped all profile behaviors) are all dead. /policy validate sees the
  RAW config so it still diagnoses the actual mistakes.
- **Unified budget priority** (P2): one budget walk —
  core > project > rigor/flow > concern > domain > profile > model. A
  repo's own constraints are no longer the first thing dropped so
  model.minimax-* can fit.
- History-file dead static imports removed; test count 148 → 168;
  regression corpus 36 → 45 (scoped negation, planning deliverables,
  explicit gate, design-vs-implement).

## 0.20.0

1.0 audit hardening — boundary semantics + security fix. No new features.

- **P0 security: project-policy manifest path containment.** A manifest
  entry `{"path": "../../secret.md"}` escaped .pi/policies and injected
  arbitrary files into the system prompt (verified). Entry paths are now
  containment-checked before any read: no absolute paths, no .., .md
  only, and the REALPATH of the target must sit strictly inside the
  policy root (symlink escapes included). Rejected entries are named in
  /policy why instead of failing silently.
- **P0 semantics: later corrections override earlier intent.**
  extractExecutionIntent was "any live mutation short-circuits", so
  "先修改代码，不要修改，只分析" classified as mutate. Intent is now
  resolved SEQUENTIALLY: correction heads (不对/等等/算了/actually/
  scratch that…) clear the active intent; a negated clause only revokes
  the same kind it negates ("只分析，不要修改" stays read-only);
  the last effective instruction wins. The intent frame also skips
  clauses before the last correction ("帮我修复，不对，先别改，只分析
  原因" now anchors on 分析, not 修复).
- **P1: continuity inherits concerns + typed follow-ups.** A "继续" after
  a security-relevant task no longer drops the security concern. Follow-
  ups are now classified: execute ("按这个做"/"继续修"/"do it") converts
  advice into mutation — "按这个做" after a read-only analysis is now
  mutate, not inherited read-only; inspect/neutral keep the inherited
  intent.
- **P1: plan revisions re-route the decision.** The revise branch
  conservatively merges the revision text's evidence into the decision:
  risk only up, domains/concerns union, task/flow/intent untouched.
  "批准，但是这是生产数据库，不要改 schema" now raises risk, adds the
  database domain, and loads the production + security concerns (was:
  old decision reused verbatim).
- **P1: concern riskFloor.** A STRONG security concern hit floors risk at
  high (weak signals never floor): "修改 JWT 鉴权逻辑" → strict;
  "解释 JWT 鉴权逻辑" stays standard via the existing read-only
  downgrade. security.md and the router finally agree that auth changes
  are high-impact.
- **P1: manifest filters are AND across dimensions** (OR within one):
  `{"tasks":["architecture"],"domains":["database"]}` requires both —
  the previous ANY-match loaded architecture+frontend too.
- **P1: project config discovery walks up** like project policies:
  .pi/policy-engine.json is found from cwd to the git root, nearest
  wins; broken JSON is reported by /policy validate instead of silently
  ignored.
- **P1: strict plans survive session restarts.** awaiting_approval (+
  a minimal decision) is persisted next to the history file and
  restored on session_start (cwd-matched, ≤ 7 days old; /policy cancel
  discards). Plan in the evening, /resume + 批准 in the morning now
  routes through the approval classifier. Concurrency caveat: two live
  sessions in one project share the file; last writer wins, and the
  failure direction is safe (asks again, never auto-releases).
- **P2**: /policy validate now checks mode/profile enums, numeric
  ranges, semanticFallback shape, and broken config JSON; unknown
  includePolicies are reported as "unavailable (not in manifest)"
  instead of "truncated by byte budget"; dropped project policies are
  listed in /policy why; /policy preview shows executionIntent, flow,
  and concerns; domainHints show "explicit hint" reasons; history files
  rotate (512 KB threshold → keep last 1000 entries); /policy cancel
  and reset also clear the persisted strict state; concerns/security.md
  retitled Security Concern.
- Tests 130 → 148; regression corpus 30 → 36.

## [Unreleased] 1.0.0 — schema/config/terminology freeze (pending final approval)

Not yet released: the original 1.0.0 entry was published out of order
(package stayed 0.x). 0.20–0.21 constitute the release-candidate series;
1.0.0 is cut from this surface once the audit blockers are confirmed
closed. No new features — the surface below is the supported contract.

Frozen surface:

- Terminology: task / risk / executionIntent / domains / concerns /
  rigor / flow / profile / phase. The workflow axis was split into
  rigor + flow in v0.19 and will not be reintroduced.
- Config schema: mode, profile, showStatus, maxDomains,
  policyMaxBytes (unified total), projectPolicyMaxFiles/MaxBytes,
  projectPolicies, include/excludePolicies, domainHints, historyFile,
  historyMaxEntries, semanticFallback, concernRules/taskRules/
  domainRules (config/routing.json), model rules (config/models.json),
  project policy manifest (.pi/policies/manifest.json).
- Decision shape: taskType, risk, confidence, executionIntent, domains,
  concerns, rigor, flow, profile, modelPolicy, reasons (+ bookkeeping:
  loadedPolicies, truncatedPolicies, policyBytes, policyBudget).
- History JSONL: field name `workflow` retained for old-file
  compatibility; new writers store the rigor value in it.
- Commands: /policy auto|quick|standard|strict|off|once|profile|
  preview|diff|history|config|validate|status|why|cancel|reset.

The eight foundational principles are formalized in DESIGN §1a. Known
future option (NOT in 1.0): an opt-in strictPhaseGuard limited to
edit/write/apply_patch during planning/awaiting_approval — see DESIGN
§6; it stays unimplemented until evidence demands it.

## 0.19.0

Flow/Rigor split + configurable model routing + /policy why budget line.
Breaking semantic change (deliberate, ahead of 1.0 freeze).

- **Flow / Rigor split**: the single `workflow` axis is now two orthogonal
  dimensions — `rigor` (how strict: quick/standard/strict, from risk +
  intent) and `flow` (how to work: debug-first/review-first/research-first,
  from task type). debug-first + quick and debug-first + strict are both
  expressible; profiles no longer carry flow policies, killing the old
  profileHasWorkflow special case. Policy files moved:
  workflows/ → flows/ + rigors/; manifest ids flow.*/rigor.*;
  decision/compare/diff/preview/status/history all speak rigor+flow
  (history JSONL keeps the `workflow` field name for old-file compat).
- **Model routing externalized**: config/models.json rules
  (first rule whose every match token appears in provider/id wins).
  router.js keeps a built-in fallback; extending model support no longer
  requires code changes.
- **/policy why completeness**: shows concerns and a
  `policy budget: X KB / Y KB` line (unified built-in + project total).

## 0.18.0

Task continuity + Domain/Concern split + project-policy discovery upgrade.

- **Task Continuity**: whole-message follow-ups ("继续" / "还是不对" /
  "再看看" / "按这个做") inherit taskType + domains from the previous
  decision instead of re-classifying as coding/medium/none (which dropped
  the model off its constraint context). Execution intent is recomputed
  (a live intent on the follow-up wins; unclear falls back to the
  inherited one); risk escalates ONLY when the follow-up itself produced
  a risk reason — the no-evidence default "medium" never turns a quick
  task into standard (smoke caught exactly that during implementation).
  Follow-ups carrying their own instructions ("继续，只分析") do NOT
  match. Continuity is off when the last workflow was off or absent.
- **Domain / Concern split**: a concern (security, production) answers
  "what needs extra care", not "where does this happen" — it never
  competes for maxDomains slots. routing.json gains `concernRules`;
  "postgresql schema + spring controller + jwt 鉴权" now loads
  database + backend domains AND the security concern (previously
  security lost the cap race and was dropped). New
  policies/concerns/{security,production}.md; manifest ids
  concern.security / concern.production; concerns flow through
  buildDecision, compareDecisions, and the injected block summary;
  semantic fallback's domain enum no longer includes security
  (concerns are deterministic-only).
- **Ancestor project-policy discovery**: .pi/policies is found from cwd
  upward to the enclosing git root — starting pi in repo/backend/service-a
  now sees repo/.pi/policies. Nearest root shadows duplicate relative ids.
- **Conditional project policies**: an optional .pi/policies/manifest.json
  gates loading — each entry may filter by tasks / domains / concerns
  against the current decision (no filters = always); unlisted files do
  not load, so a large policy directory stays quiet.

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
