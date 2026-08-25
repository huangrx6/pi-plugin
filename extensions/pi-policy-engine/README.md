# pi-policy-engine

<!-- markdownlint-disable MD013 -->
<!-- 中文文本 + 表格按 80 字符硬折行会破坏可读性，本文件不禁用行宽规则 -->

给 Pi Coding Agent 加一个**策略层**：在 prompt 进来时自动根据任务类型、风险、领域、模型选一套工作流（quick / standard / strict），把约束注入 system prompt；在 strict 流程下用机械门禁阻止未批准前的写操作。

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
| 数据库迁移、生产、k8s、认证、架构设计 | `strict`（plan + 等你批准 + 分 wave 执行） |

**2. 想看为什么**——发任意 prompt 后：

```text
/policy why
```

显示上一轮命中的所有规则（task / risk / domain / model policy）和最终决策。

**3. 想手动覆盖**：

```text
/policy                       # 弹交互选择器（mode / gate / profile 三组）
/policy strict                # 强制 strict workflow
/policy once quick            # 仅下一轮用 quick
/policy gate hard             # 写操作 + mutating shell 都拦截
/policy profile debugging     # 切到 debugging 策略集
/policy cancel                # 取消 pending strict plan
/policy reset                 # 清空所有 runtime override
```

### 看到效果

- footer 状态行多一栏：`policy:strict/planning` 或 `policy:standard/executing` 等
- strict 下模型先出 plan，**等你回「执行」/「批准」/「开始执行」才动手**
- 写文件类工具被机械拦截，模型会看到拦截原因并自我修正

## 行为细节

### Workflow 选择

```text
prompt 进入
   ↓
Classifier（确定性规则匹配，无 LLM 调用）
   ↓ 任务类型 + 风险 + 领域 + 模型 + 用户 override
   ↓
Policy Router
   ├─ 风险 high → strict（plan + 批准 + 分 wave）
   ├─ 风险 low  → quick
   └─ 其余      → standard
```

为什么用规则不用 LLM？**让模型自己决定该给自己什么约束是循环依赖**。规则路由快、可解释、不会因为模型分心而漏判。

### Gate（机械门禁）

strict + pending approval 时按 gate 等级阻止：

| gate | 阻止什么 |
| --- | --- |
| `off` | 不拦截，靠 prompt 约束 |
| `soft`（默认） | 拦截 `write` `edit` `apply_patch` `patch` `replace` `delete_file` `move_file` 等直接写文件工具 |
| `hard` | 在 soft 基础上，识别并拦截 mutating shell：`rm`、`mv`、`cp`、`mkdir`、`chmod`、`chown`、`sed -i`、`tee`、git 变更命令、`npm install`、`kubectl apply` `delete` 等、`helm upgrade` 等 |

shell 判断是**保守正则规则集**，不是完整 shell AST。`hard` 模式先在项目里跑跑。`/policy gate` 无参弹交互选择器，可按分类勾选。

### Policy 层叠加

每次启动按需叠加 5 类 policy Markdown：

- **core**：evidence priority / constraint retention / verification（总是加载）
- **behavior**：execution discipline / minimal change / context hygiene / tool discipline（按 profile 加载）
- **workflow**：quick / standard / strict-plan / strict-execute / debug-first / review-first / research-first
- **domain**：database / kubernetes / security / backend / frontend / documentation（按命中关键词加载）
- **model**：minimax-m3 / deepseek（按当前模型加载）

`policies/manifest.json` 注册全局可复用 policy；项目级 policy 放 `.pi/policies/**/*.md`，**不需要改 manifest**。

每个 policy 是 1 个 Markdown 文件，运行时拼到 system prompt 末尾。带 token 预算（默认 24 KB），超出按优先级裁剪。

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

项目策略 Markdown 在内置策略之后追加。**用户当前明确要求仍具有最高任务语义优先级**——策略不能压过用户意图。

### 全局配置示例

`~/.pi/agent/policy-engine.json`：

```json
{
  "mode": "auto",
  "gate": "soft",
  "profile": "auto",
  "showStatus": true,
  "includePolicies": ["behavior.execution-discipline"],
  "excludePolicies": [],
  "domainHints": ["backend"],
  "projectPolicyMaxFiles": 12,
  "projectPolicyMaxBytes": 24000
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
  "gate": "hard",
  "profile": "auto",
  "domainHints": ["backend"],
  "projectPolicies": ["compatibility.md"]
}
```

不写 `projectPolicies` 就自动扫 `.pi/policies/**/*.md`（上限默认 12 文件 / 24 KB）。

### 完整命令表

| 命令 | 作用 |
| --- | --- |
| `/policy` | 弹交互选择器（mode / gate / profile 三组） |
| `/policy auto\|quick\|standard\|strict\|off` | 切换 runtime mode |
| `/policy once <mode>` | 仅下一轮用指定 mode |
| `/policy gate off\|soft\|hard` | 切换 gate 等级 |
| `/policy profile <name>` | 切 profile（auto / coding / debugging / documentation / architecture / review / research） |
| `/policy status` | 当前 mode / gate / profile / phase / 模型 |
| `/policy why` | 上一轮的完整路由决策（含命中规则） |
| `/policy cancel` | 取消 pending strict plan |
| `/policy reset` | 清空所有 runtime override |

### 已知限制

- V0.x classifier 是规则式不是语义模型，复杂隐晦任务路由可能不完美 → 用 `/policy once ...` 覆盖
- shell mutation guard 用正则不是完整 shell AST，`hard` 模式应先在工作流测试
- runtime `/policy` override 只在当前 Pi 进程；持久化请写 global/project `policy-engine.json`
- strict approval 依赖明确批准语句（白名单）；刻意设计，避免模糊语句意外放开修改门禁

## 自定义 policy

新增一个全局可复用 policy：

1. 在 `policies/<layer>/<name>.md` 写 Markdown
2. 在 `policies/manifest.json` 注册 id → 文件路径
3. 放入某个 `profiles/<name>.json` 的 `policies` 数组，或通过配置 `includePolicies` 启用

新增项目专属 policy：直接放 `.pi/policies/<name>.md`，**不用改 manifest**。

扩展路由关键词：编辑 `config/routing.json` 的 `taskRules / domainRules / highRisk / mediumRisk`——纯数据驱动，**不需要改 classifier 代码**。

## 与 AGENTS.md / Skill / pi-mode-switcher 的边界

```text
AGENTS.md
  = 极少量、永远成立的项目/全局宪法规则

Skill (pi-skill-inject)
  = 某个专业能力具体怎么做（数据库迁移、绘图、专项研究）

pi-policy-engine (本扩展)
  = 动态行为规则 + workflow 路由 + model/domain adaptation + 机械门禁

pi-mode-switcher (同仓库另一扩展)
  = 三级人工批准（每次写文件 / 危险 bash 弹确认框）
```

**policy-engine 不替代** AGENTS.md / Skill / mode-switcher；职责分工：

- **AGENTS.md** — 极少量、永远成立的项目/全局宪法规则
- **Skill（pi-skill-inject）** — 某个专业能力的具体做法（数据库迁移、专项研究等）
- **pi-policy-engine** — 自动 workflow 路由 + 任务级 plan + 执行门禁 + model adaptation
- **pi-mode-switcher** — 每次写操作 / 危险 bash 的人工弹框确认

| 维度 | AGENTS.md | Skill | policy-engine | mode-switcher |
| --- | --- | --- | --- | --- |
| 项目宪法 | ✓ |  |  |  |
| 专业能力 SOTA |  | ✓ |  |  |
| 自动 workflow 路由 |  |  | ✓ |  |
| Model adaptation |  |  | ✓ |  |
| 任务级 plan + 批准 |  |  | ✓ |  |
| 每次写操作的人工弹框 |  |  |  | ✓ |
| 持久化权限模式 |  |  |  | ✓ |

`mode-switcher` 是**用户每次决策**，`policy-engine` 是**自动路由**——两者正交，常一起用：mode-switcher 给总闸（ask / smart / full），policy-engine 在自动路由出来的 strict 流程上加 plan-then-execute 的额外保险。

## 实现原理（面向维护者）

### 文件结构

```text
pi-policy-engine/
├── README.md / DESIGN.md / CHANGELOG.md
├── extensions/policy-engine/         # Pi 扩展入口
│   └── index.js                     # 装配 + 事件注册
├── src/core/                        # 核心逻辑
│   ├── classifier.js                 # 规则式 task/risk/domain 分类
│   ├── router.js                    # classification → decision
│   ├── loader.js                    # 加载 policies + token 预算
│   ├── guard.js                     # 批准语句识别 + tool/shell mutation 拦截
│   └── config.js                    # 四层配置合并
├── policies/                        # Markdown 策略
│   ├── core/ behaviors/ workflows/ domains/ models/
│   └── manifest.json                # 全局 policy 注册表
├── profiles/                        # profile JSON（policy 组合）
├── config/
│   ├── defaults.json
│   └── routing.json                 # 路由关键词（数据驱动）
├── examples/                        # 可试用的小例子
│   ├── README.md
│   └── project/.pi/
└── scripts/                         # self-test + smoke-extension
```

### 事件流（一次 strict 任务的完整链路）

```text
user prompt "设计生产环境 PG 迁移方案"
        ↓
session_start → 加载 config、project policies
        ↓
before_agent_start
  ├─ 合并 defaults / global / project / runtime config
  ├─ classifyTask(prompt, routing, domainHints)
  ├─ buildDecision(...) → workflow: strict
  ├─ composePolicies({ phase: "planning" })
  ├─ loadProjectPolicies(cwd)
  └─ 拼到 event.systemPrompt 末尾
        ↓
model → 返回 Task Contract + Constraint Ledger + plan（PLAN-ONLY）
        ↓
agent_end → 状态保持 pendingApproval
        ↓
user: "为什么第二步要这样做？" （非批准）
  ↓
before_agent_start
  ├─ 命中 pendingApproval + 非批准追问
  └─ 拼回 planning phase + "do not execute until explicit approval"
        ↓
user: "开始执行"
  ↓
isApprovalPrompt → true
  ↓
before_agent_start
  ├─ pendingApproval = false, phase = "executing"
  └─ 拼 strict-execute policy
        ↓
tool_call(edit) → pendingApproval=false → 放行
tool_call(bash, "kubectl apply") → hard gate 但已批准 → 放行
```

### 关键设计点

| 机制 | 说明 |
| --- | --- |
| **零 monkey-patch** | 只走官方事件流（`session_start` / `before_agent_start` / `tool_call` / `agent_end` / `model_select`），不修改 Pi 内部类 |
| **确定性路由** | 规则匹配 + 数据驱动关键词，无 LLM 调用；快、可解释、不会因模型分心漏判 |
| **状态机严格** | pendingApproval 期间非批准追问不会降级，必须 `/policy cancel` 才能放弃 |
| **可解释** | `/policy why` 列出全部命中规则、最终决策、加载的 policy 列表（含 token 预算裁剪提示） |
| **模型适配** | `model.minimax-m3` / `model.deepseek` 补偿特定模型的 execution drift 模式 |
| **token 预算** | composePolicies 按 core > workflow > domain > model > project 优先级裁剪，避免 system prompt 膨胀 |
| **深合并配置** | mergeConfig 深合并嵌套对象；数组按 id 去重 |
| **机械 + 提示双层防御** | prompt 约束（policy Markdown）+ 工具层 gate（guard.js），光绕 prompt 拦不住 |

完整设计见 [DESIGN.md](./DESIGN.md)。

## License

MIT © huangrx6
