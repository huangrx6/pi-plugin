<!-- markdownlint-disable MD013 MD033 MD036 MD041 -->
<div align="center">

# 🛠️ pi-policy-engine

**任务流程铁律层 — 注入"严格流程"指令到 system prompt，模型自己遵守、自己停下问**

</div>

---

## 它做什么

在 prompt 进来时，根据任务类型/风险/领域/模型自动选一套工作流（quick / standard / strict），把**任务铁律**注入 system prompt。strict 流程下，模型得到的指令明确写："this turn is PLAN-ONLY… stop after the plan and ask for approval"。**模型自己读、自己遵守、自己停下问用户**——和 skill 里写"这里必须让用户确认"是一回事。

**职责边界**：本扩展只作用于**任务行为层**（system prompt 注入 + 流程状态机）。任何工具调用是否被允许、是否需要人工弹框——不是本扩展的事，是权限类扩展的职责。两者完全独立、互不感知，**装上就用，不要求也不假设别的东西存在**。

## 一个完整例子

你发了一条 prompt：

```text
设计生产环境 PostgreSQL schema 迁移方案并实施
```

**1. Classifier（确定性规则，无 LLM 调用）判定** risk=high → workflow=strict。

**2. `before_agent_start` 把这段话注入 system prompt**（节选）：

```text
# Active Policy Runtime
Workflow: strict
Phase: planning

## Policy: workflow.strict-plan
This turn is PLAN-ONLY. Do not mutate files, configuration, infrastructure,
or external state. Produce a concise but explicit Task Contract and
Constraint Ledger. ... Stop after the plan and ask for approval. Do not
start implementation in the same turn.
```

**3. 模型看到指令 → 输出 Task Contract + Constraint Ledger + plan，然后停下**。它**不会**发任何 tool_call（因为指令明确写"Do not mutate"）。

**4. 你回** "开始执行，按这个计划做"。`before_agent_start` 检测到是批准语句，状态从 planning 切到 executing，注入 `strict-execute` policy，模型分 wave 执行。

如果中途你回 "为什么第二步要这样做？"——非批准追问，状态保持 planning，追加 "do not execute until explicit approval" 提示，**不会意外降级**。

> 注意：本扩展**不监听 `tool_call`**。如果模型不遵守 PLAN-ONLY 指令自己改文件，本扩展不会拦它——那是权限层的事。这个分工是刻意的。

## 快速开始

### 安装

```bash
pi install git:github.com/huangrx6/pi-plugin
```

或只装这一个：

```bash
pi install git:github.com/huangrx6/pi-plugin/extensions/pi-policy-engine
```

重启 pi 或 `/reload` 热加载。**零运行时依赖**，不绑 Pi 的 npm namespace。

### 上手 3 步

**1. 装上就用**——不需要写任何配置。默认按 prompt 内容自动选 workflow：

| prompt 类型 | 自动选什么 |
| --- | --- |
| README、文档、注释、拼写 | `quick`（Inspect → Change → Verify） |
| 普通 bug 修复、改代码 | `standard`（Task Contract → Inspect → Plan → Execute → Verify） |
| 数据库迁移、生产、k8s、认证、架构设计 | `strict`（plan + 停下等批准 + 分 wave 执行） |

**2. 想看为什么**——发任意 prompt 后：

```text
/policy why
```

显示上一轮命中的所有规则（task / risk / domain / model policy）和最终决策。

**3. 想手动覆盖**：

```text
/policy                       # 弹交互选择器（mode / profile）
/policy strict                # 强制 strict workflow
/policy once quick            # 仅下一轮用 quick
/policy profile debugging     # 切到 debugging 策略集
/policy cancel                # 取消 pending strict plan
/policy reset                 # 清空所有 runtime override
```

### 看到效果

- footer 状态行多一栏：`policy:strict/planning` 或 `policy:standard/executing` 等
- strict 下模型先出 plan，**自己停下等你回「执行」/「批准」/「开始执行」才动手**——这是任务行为，不是工具拦截
- 工具权限层（如果你用的话）独立工作，本扩展不干预它的任何决定

## 行为细节

### Workflow 选择

```text
prompt 进入
   ↓
Classifier（确定性规则匹配，无 LLM 调用）
   ↓ 任务类型 + 风险 + 领域 + 模型 + 用户 override
   ↓
Policy Router
   ├─ 风险 high → strict（plan + 停下等批准 + 分 wave）
   ├─ 风险 low  → quick
   └─ 其余      → standard
```

为什么用规则不用 LLM？**让模型自己决定该给自己什么约束是循环依赖**。规则路由快、可解释、不会因为模型分心而漏判。

### Domain 降噪（v0.13）

早期版本"关键词命中就全收"：一个 `组件` 就加载整个 frontend policy，一个 `权限` 就加载 security——模型还没开始干活，先被塞了 13 条规则。**本扩展为了减少上下文噪声而存在，自己不能制造噪声**。

现在的规则：

- 领域关键词分 **strong / weak** 两档（`config/routing.json`）：
  - strong（`postgres`、`react`、`jwt`、`kubectl` …）：命中即加载该领域
  - weak（`组件`、`api`、`权限`、`sql` …）：单独出现**不触发**；同领域凑满 2 个弱信号，或搭配一个框架词（`React` + `组件`）才触发
- 触发的领域按得分排序，最多加载 `maxDomains` 个（默认 2），其余在 reasons 里写明裁剪原因
- confidence 计入候选分散度：多个 task type 打平时置信度主动下调（最高 -0.35），碾压级胜出不受影响——不再出现"三个候选打平还给 0.95"的虚假数字

每个裁剪/降权决定都写进 `/policy why` 的 reasons，可审计：

```text
domain:backend dropped (weak-only: 接口 (score 0.5 < 1, needs a frame term or a second signal))
domain:security dropped (capped at 2; weaker than database, frontend)
confidence penalized: candidates dispersed (top=6, runner-up=6, dominance=0.00)
```

### Strict 审批（纯任务行为层）

strict 的 plan 批准**不是工具拦截**，而是注入给模型的明确指令：

- planning 阶段注入 `strict-plan` policy：明确写 "This turn is PLAN-ONLY. Do not mutate… Stop after the plan and ask for approval."
- 模型遵守指令 → 输出 plan 后停下，等你批准（不会发起任何写操作，所以也不会有工具被拦）
- 你回批准语句（「执行」/「开始执行」/「批准」/「通过」/「可以执行」）→ `before_agent_start` 检测到，切到 executing 阶段，注入 `strict-execute` policy
- 批准前你的非批准追问（「为什么第二步要这样做？」）→ 状态机保持 planning，追加 "do not execute until explicit approval"，**不会意外降级**

注意：这是**软约束**——它依赖模型遵守指令。如果模型在 PLAN-ONLY 阶段仍然发起了写工具调用，本扩展不会拦它；是否拦截取决于你运行的其他权限工具。这是刻意设计：流程纪律归本扩展，工具权限归权限扩展，两者不重叠。

#### 确认短语白名单

```text
「执行」/「开始执行」/「批准」/「通过」/「可以执行」/「继续执行」
「approve」/「approved」/「proceed」/「go ahead」/「do it」
```

模糊用语（"差不多就改吧"、"好像可以"）**不会**触发批准切换——避免误操作。

### 执行意图：read-only / mutate / unclear

每轮 prompt 还会被提取一个三值**执行意图**，出现在 `/policy why` 输出中：

| intent | 判定 | 例 |
| --- | --- | --- |
| `mutate` | 存在任何修改动词且未被否定 | 帮我**修复**这个 bug / **优化**性能 |
| `read-only` | 只有阅读类动词、无修改动词 | 只**分析**，不要修改 / **排查**为什么返回旧数据 |
| `unclear` | 只有模糊动词或无动词 | 帮我**看看**这个 / 继续 |

规则要点：

- **否定作用域**：「不要只分析」里的"分析"不算数——否定词窗口内的动词是死证据；所以 "不要只分析，直接修改代码" = mutate（旧版 analysisOnly 在这句会判错）
- **名词话题抑制**：「迁移**方案**的风险」「README 里**写了**什么」是提及不是请求——Intent beats mention
- read-only 意图会自动把 strict 降级为 standard/quick（纯阅读不需要审批循环）；`unclear` 保持完整严格度（无法证明不会改动）
- 语义兑底若未明确断言 intent，则保留确定性判定结果

### 调试命令

#### Dry-run 预览：`/policy preview <prompt>`

不发 prompt 给 agent，直接看给定 prompt 会走哪条路由、加载哪些 policies、byte 预算使用多少：

```text
/policy preview 设计生产环境 PG schema 迁移方案
```

输出（节选）：

```text
# Policy preview (dry run; nothing is executed)

task: architecture
risk: high
confidence: 0.9
domains: database, kubernetes
workflow: strict
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

preview 是**纯读**：不动 session state、不发请求给 agent、不发请求给 semantic fallback。

#### 对比两条 prompt 的路由：`/policy diff <promptA> || <promptB>`

调 `config/routing.json` 关键词、加 domainHints、改某个 policy 后，看两条 prompt 路由是不是如预期般不同：

```text
/policy diff "修一个 PG migration bug" || "改 README typo"
```

输出：

```text
# Policy diff

LEFT : 修一个 PG migration bug
RIGHT: 改 README typo

LEFT
  workflow: strict
  task / risk: architecture / high
  ...
RIGHT
  workflow: quick
  task / risk: documentation / low
  ...

Differences (4):
  workflow: strict  →  quick
  task: architecture  →  documentation
  risk: high  →  low
  would require approval: yes  →  no
```

分隔符是 `||`（两边不需空格）。

#### Resolved 配置：`/policy config`

打印当前**实际生效**的 merged 配置（defaults + global + project + runtime override 四层合起来）：

```text
/policy config
```

输出：

```text
# Resolved policy-engine config

routing
  mode: auto
  profile: auto
  showStatus: true
  domainHints: ["backend","database"]

policies
  projectPolicyMaxFiles: 12
  projectPolicyMaxBytes: 24000
  policyMaxBytes: 24000
  maxDomains: 2
  includePolicies: ["behavior.execution-discipline"]
  excludePolicies: []

semanticFallback
  enabled: false
```

不告诉你**哪一层覆盖了哪一层**——要查 source 层，自己读 `~/.pi/agent/policy-engine.json` 和 `<project>/.pi/policy-engine.json`。

#### 配置校验：`/policy validate`

调完配置还没起 pi 时主动检查问题：

```text
/policy validate
```

校验项：

- `includePolicies` / `excludePolicies` 是否引用 manifest 里的 id，或 `core.*` / `model.*` 内置前缀——警告（拼错会静默忽略）
- `policies/manifest.json` 里每个路径是否真存在——错误
- `profiles/*.json` 里每个 id 是否引用 manifest 里的项——错误

#### 路由历史：`/policy history [N]` / `/policy history clear-disk`

回看本 session 内所有路由决策（决定性 + preview），默认 5 条，可指定 N。跨 session 持久化到 `historyFile`（默认 `~/.pi/agent/policy-engine/history.jsonl`，JSONL 每行一条）。`clear-disk` 清空磁盘文件。

## 配置

### 配置优先级

```text
package defaults
  ↓
~/.pi/agent/policy-engine.json     ← 用户全局
  ↓
<project>/.pi/policy-engine.json   ← 项目级
  ↓
runtime /policy override           ← 进程内（/policy 命令）
```

### 全局配置示例

`~/.pi/agent/policy-engine.json`：

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

### 项目配置示例

```text
my-project/
└── .pi/
    ├── policy-engine.json
    └── policies/
        ├── compatibility.md
        └── architecture.md
```

`.pi/policy-engine.json`：

```json
{
  "mode": "auto",
  "profile": "auto",
  "domainHints": ["backend"],
  "projectPolicies": ["compatibility.md"]
}
```

不写 `projectPolicies` 就自动扫 `.pi/policies/**/*.md`（上限默认 12 文件 / 24 KB）。

### 可选：语义兜底（semanticFallback）

V0.x 确定性分类器在隐晦提示下可能不准。可选启用一个 OpenAI 兼容的语义重分类器作为兜底：

- **默认关闭**——需要联网 + API key，按需启用
- 仅在确定性结果 `confidence < confidenceThreshold`（默认 0.7）时调用
- 任意失败（超时 / 网络 / 响应 schema 不匹配）→ 静默回退到确定性结果，**不会阻塞 agent**
- 启用后在 `decision.reasons` 里看到 `semantic-fallback: ...`，可以通过 `/policy why` 验证它是否生效

配置示例：

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

API key 通过**环境变量名**读取（`apiKeyEnvVar`），不存配置文件里。换 provider 时改 `endpoint` + `model` + `apiKeyEnvVar` 即可——不限于 OpenAI。

## 完整命令表

| 命令 | 作用 |
| --- | --- |
| `/policy` | 弹交互选择器（mode / profile） |
| `/policy auto\|quick\|standard\|strict\|off` | 切换 runtime mode |
| `/policy once <mode>` | 仅下一轮用指定 mode |
| `/policy profile <name>` | 切 profile（auto / coding / debugging / documentation / architecture / review / research） |
| `/policy preview <prompt>` | 不触发 agent，直接看路由结果 |
| `/policy diff <promptA> \|\| <promptB>` | 对比两条 prompt 的路由决策 |
| `/policy history [N\|clear-disk]` | 本 session 内最近的 N 条路由决策（默认 5），`clear-disk` 清空磁盘历史 |
| `/policy config` | 打印当前 resolved 配置 |
| `/policy validate` | 校验配置（manifest 路径 / profile 引用 / include-exclude 引用） |
| `/policy status` | 当前 mode / profile / phase / 模型 |
| `/policy why` | 上一轮的完整路由决策（含命中规则） |
| `/policy cancel` | 取消 pending strict plan |
| `/policy reset` | 清空所有 runtime override |

## 已知限制

- V0.x classifier 默认是规则式不是语义模型；可选启用 `semanticFallback`（OpenAI 兼容 HTTP 调用）在确定性置信度低时调小模型重分类。默认关闭，任何失败回退到确定性结果。需要 API key + 网络，不适合离线场景。
- **strict 审批是软约束（任务行为层）**：它指导模型"PLAN-ONLY、停下等批准"，但不机械拦截。模型不遵守时的兜底由你运行的权限扩展负责（如有）。
- runtime `/policy` override 只在当前 Pi 进程；持久化请写 global/project `policy-engine.json`
- strict approval 依赖明确批准语句（白名单）；刻意设计，避免模糊语句意外放行

## 自定义 policy

新增一个全局可复用 policy：

1. 在 `policies/<layer>/<name>.md` 写 Markdown
2. 在 `policies/manifest.json` 注册 id → 文件路径
3. 放入某个 `profiles/<name>.json` 的 `policies` 数组，或通过配置 `includePolicies` 启用

新增项目专属 policy：直接放 `.pi/policies/<name>.md`，**不用改 manifest**。

扩展路由关键词：编辑 `config/routing.json` 的 `taskRules / domainRules / highRisk / mediumRisk`——纯数据驱动，**不需要改 classifier 代码**。

## 与 AGENTS.md / Skill 的边界

```text
AGENTS.md
  = 极少量、永远成立的项目/全局宪法规则

Skill
  = 某个专业能力具体怎么做（数据库迁移、绘图、专项研究）

pi-policy-engine (本扩展)
  = 动态行为规则 + workflow 路由 + model/domain adaptation
```

本扩展不替代 AGENTS.md / Skill，也不假设它们存在。

## 实现原理（面向维护者）

### 文件结构

```text
pi-policy-engine/
├── README.md / DESIGN.md / CHANGELOG.md
├── extensions/policy-engine/         # Pi 扩展入口
│   └── index.js                     # 装配 + 事件注册
├── src/core/                        # 纯逻辑层（无 pi 依赖，可独立测试）
│   ├── classifier.js                 # 规则式 task/risk/domain 分类
│   ├── router.js                    # classification → decision
│   ├── loader.js                    # 加载 policies + byte 预算
│   ├── approval.js                  # 批准语句识别（strict 状态机用）
│   ├── config.js                    # 四层配置合并
│   ├── semantic.js                  # 可选语义兜底
│   └── history-store.js             # 路由历史 JSONL 持久化
├── policies/                        # Markdown 策略
│   ├── core/ behaviors/ workflows/ domains/ models/
│   └── manifest.json                # 全局 policy 注册表
├── profiles/                        # profile JSON（policy 组合）
├── config/
│   ├── defaults.json
│   └── routing.json                 # 路由关键词（数据驱动）
├── examples/                        # 可试用的小例子
└── scripts/                         # self-test + smoke-extension
```

### 事件流（一次 strict 任务的完整链路）

```text
user prompt "设计生产环境 PG 迁移方案"
        ↓
before_agent_start
  ├─ 合并 defaults / global / project / runtime config
  ├─ classifyTask(prompt, routing, domainHints)
  ├─ buildDecision(...) → workflow: strict
  ├─ composePolicies({ phase: "planning" }) → 注入 strict-plan policy
  ├─ loadProjectPolicies(cwd)
  └─ 拼到 event.systemPrompt 末尾
        ↓
model → 返回 plan（PLAN-ONLY，指令要求停下等批准）
        ↓
user: "为什么第二步要这样做？" （非批准）
  ↓
before_agent_start 检测 pendingApproval + 非批准
  └─ 保持 planning + "do not execute until explicit approval"
        ↓
user: "开始执行"（isApprovalPrompt → true）
  ↓
before_agent_start
  ├─ pendingApproval = false, phase = "executing"
  └─ 注入 strict-execute policy
        ↓
model 分 wave 执行（无任何工具拦截——权限层不在本扩展）
```

### 关键设计点

| 机制 | 说明 |
| --- | --- |
| **零工具拦截** | 不监听 `tool_call`，纯 system prompt 注入 + before_agent_start 状态机。与任何权限扩展零交互、零感知 |
| **确定性路由** | 规则匹配 + 数据驱动关键词，无 LLM 调用；快、可解释、不会因模型分心漏判 |
| **状态机严格** | pendingApproval 期间非批准追问不会降级，必须 `/policy cancel` 才能放弃 |
| **可解释** | `/policy why` / `preview` / `diff` / `history` 全链路可查 |
| **模型适配** | `model.minimax-m3` / `model.deepseek` 补偿特定模型的 execution drift 模式 |
| **byte 预算** | composePolicies 按优先级裁剪，避免 system prompt 膨胀 |
| **深合并配置** | mergeConfig 深合并嵌套对象；数组按 id 去重 |

完整设计见 [DESIGN.md](./DESIGN.md)。

## License

MIT © huangrx6
