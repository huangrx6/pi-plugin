<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-policy-engine</h1>

<p align="center">按任务选择执行流程，并让每一次策略注入都可解释、可核对。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

为 Pi 的编码、排障、审查和调研任务追加适用的执行要求。支持带任务上下文的大模型优先识别，也保留离线规则和兼容的低置信度回退模式。你可以查看识别来源、降级原因、加载的要求，以及当前是否在等待确认。默认离线，启用模型识别见下文。

## 快速开始

在本扩展包目录中执行，单独安装此扩展：

```bash
pi install "$PWD"
```

重启 Pi 或执行 `/reload`，发送一个任务，再输入 `/policy` 查看本次行为。默认 `auto` 模式，无需配置，也不需要额外 API Key。

## 实际体验

**任务决定流程。** 简单任务走 `quick`，常规工作走 `standard`，高风险或明确要求确认的工作进入 `strict`。排障、审查和调研还会叠加各自的处理顺序；严格度与任务流程分别判断。

**变化留下记录。** 实际注入内容变化时，对话中显示一条策略摘要。展开后可查看触发依据、已加载要求、因预算或缺失未加载的项，以及当时的流程安排。重复注入不会反复刷屏，历史卡片不会随新任务改写。

**详情随时可查。** `/policy` 打开分组面板，可进入任务与审批、设置与保存、诊断或命令说明。每个选项直接注明作用、调用来源和持久化范围；需要输入请求内容的预览与比较仍使用文本命令。显示使用当前终端主题，中文与 emoji 按显示宽度换行；取消选择静默返回。

| 模式 | 提供给模型的要求 |
| --- | --- |
| `auto` | 根据任务自动选择严格度，默认模式 |
| `quick` | 简短检查、修改和验证 |
| `standard` | 明确任务，检查、计划、执行并验证 |
| `strict` | 先交付计划并等待确认，再分步执行 |
| `off` | 关闭策略注入与模型适配 |

问候和感谢不追加工程策略，也不改变当前任务。新的独立请求重新分类；全面只读审查会增加覆盖清单，不要求实施审批。

严格流程中，修改计划通常继续等待确认；明确批准后进入执行。“批准，但别动数据库”等可识别的范围限制会保留为执行约束。对于实现能识别的自主授权表达，例如「构思完就执行，不用征求我的意见了」，会释放审批等待，并保留附带的执行约束。

> 策略通过系统提示约束模型，不拦截工具调用。注入记录证明的是“模型收到了什么要求”，不能证明模型已经遵守，也不能代替工具权限控制。

## 日常命令

通常只需记住 `/policy`；以下入口适合直接操作。

| 命令 | 用途 |
| --- | --- |
| `/policy` | 打开带注释的选择面板：本次行为、任务与审批、设置与保存、诊断及命令说明 |
| `/policy why` | 触发依据、实际要求与当前流程状态 |
| `/policy injected` | 查看最近实际追加的完整指令 |
| `/policy quick` | 本次运行切换为快速模式；也支持其余模式名 |
| `/policy once strict` | 仅下一次新任务决策使用指定模式；普通对话和未决计划讨论不消耗 |
| `/policy cancel` | 取消未决严格计划，不会中止正在运行的模型 |
| `/policy save global` | 保存已选模式、配置档与识别模式；`save project` 只保存模式与配置档 |
| `/policy recognition agent` | 直接复用当前 agent 模型和认证，无需另配接口；切换主模型后自动跟随 |
| `/policy recognition endpoint` | 使用独立识别服务；`primary` 沿用当前来源，`fallback` 使用旧接口回退，`off` 关闭识别 |
| `/policy task` | 查看完整目标、用户要求、约束来源与计划版本 |
| `/policy new` | 清除当前任务关联，让下一条请求重新开始 |
| `/policy approve` | 明确批准已产出的当前版本计划；发送“继续”推进 |
| `/policy reset` | 清除运行时覆盖与未决计划，重新使用文件配置 |

<details>
<summary>诊断与路由调试</summary>

| 命令 | 用途 |
| --- | --- |
| `/policy profile <name>` | 选择 `auto`、`coding`、`debugging`、`documentation`、`architecture`、`review` 或 `research` |
| `/policy preview <prompt>` | 使用当前上下文副本预览；`--new` 从新任务开始，`--semantic` 显式允许已配置的模型识别 |
| `/policy diff <A> \|\| <B>` | 比较两条提示词的路由结果 |
| `/policy history [N]` | 查看最近的路由记录，默认 5 条 |
| `/policy history clear-disk` | 清空配置的磁盘历史及当前内存历史 |
| `/policy config` | 查看合并后的配置 |
| `/policy validate` | 校验配置与策略引用 |
| `/policy status` | 查看模式、配置档和流程状态 |

`preview` 与 `diff` 默认不调用语义服务；正式运行若启用模型识别，结果可能与确定性预览不同。`preview --semantic <prompt>` 明确选择使用已启用的模型识别。预览保存诊断历史，不推进任务。

</details>

## 配置与持久化

配置从包默认、全局文件、项目文件依次合并，运行时命令覆盖优先级最高。

| 位置 | 用途 |
| --- | --- |
| `~/.pi/agent/extensions-data/pi-policy-engine/config.json` | 用户全局默认与受信任设置 |
| `.pi/policy-engine.json` | 项目路由和行为定制；支持向上查找至项目边界，较近配置优先 |
| `.pi/policies/` | 项目 Markdown 策略，可用清单按任务、领域等条件加载 |

最小项目配置：

```json
{
  "mode": "auto",
  "profile": "auto",
  "domainHints": ["backend"]
}
```

默认最多选择 2 个领域，策略正文总预算为 24,000 字节；项目策略另有最多 12 个文件、24,000 字节的上限，仍受总预算约束。意图与阶段策略优先保留；必要策略仍无法加载时，追加禁止执行和配置诊断。标题、说明及用户范围限制另计入实际注入字节，缺失或被截断的策略会反映在行为说明中。

设置 `PI_CODING_AGENT_DIR` 后，全局配置与数据使用该目录下的 `extensions-data/pi-policy-engine/`。新配置不存在时回读旧的 `policy-engine.json`；新 `state/` 不存在时沿用旧的 `policy-engine/` 数据目录。配置与状态分别判断，运行时不自动移动文件；显式配置的 `historyFile` 优先。

运行时模式和配置档默认不写回配置文件，可用 `/policy save global|project` 显式保存。`/policy config` 显示合并值及来源，结构错误由 `/policy validate` 报告；运行中配置损坏时保留最后有效配置并提示。路由历史默认写入 `~/.pi/agent/extensions-data/pi-policy-engine/state/history.jsonl`，其中包含最多 80 字符的输入摘要及任务、会话、阶段、模型和指纹信息。正常恢复优先使用同会话当前分支的工作流记录，并核对计划条目；磁盘后备状态按项目和会话隔离，最多恢复 7 天内记录。旧版仅绑定目录的审批状态保留在磁盘，升级后不自动恢复。对话中的活动卡片和工作流记录不进入模型上下文。

回合结束只表示本轮停止：结果可标为等待批准、失败、中断、缺少计划或未验证。插件不会因为 `agent_end` 就宣称测试通过或任务已验证完成。

<details>
<summary>自定义策略</summary>

包内 `policies/manifest.json` 管理策略索引，`profiles/` 组织配置档，`config/routing.json` 管理路由关键词。项目规则可先参考本包的[配置示例](examples/README.md)，使用 `/policy preview` 和 `/policy validate` 核对效果。

规则分类可能误判模糊表达。大模型优先识别用于解决任务续作、修订、问答和新任务切换；配置见下一节。

网络端点、凭证来源、历史路径、模型匹配规则等受信任设置只能从全局配置生效。项目层的对应键会被丢弃，`/policy validate` 会报告原因。

</details>

### 大模型优先识别

直接复用当前 agent 模型，无需配置另一套服务：

```text
/policy recognition agent
/policy save global
```

第一条命令启用本次运行，第二条保存为全局默认。插件通过 Pi 的 `ctx.modelRegistry.complete(ctx.model, …)` 调用当前完整模型配置，认证、OAuth、代理与平台适配由宿主处理；不读取或复制密钥。下一轮会跟随主模型切换。此接口已按本机 Pi 0.85.0 的文档和示例核对，旧宿主缺少接口时会显示 `agent_model_unavailable` 并降为规则。

识别使用隔离上下文和一次额外模型请求，不写入主对话、不执行工具，也不递归触发 agent 流程。它会增加同一服务的用量和耗时。新配置请求时限为 15 秒；已有配置保留原时限，可用 `semanticFallback.timeoutMs` 调整。默认仍关闭识别；新配置来源默认为 `agent`。

需要单独使用其他模型时，执行 `/policy recognition endpoint`。在全局 `config.json` 中合并以下配置，把接口地址、模型名称和环境变量名改为你的服务设置：

```json
{
  "semanticFallback": {
    "enabled": true,
    "strategy": "primary",
    "source": "endpoint",
    "protocol": "openai",
    "endpoint": "https://your-provider.example/v1/chat/completions",
    "model": "your-classifier-model",
    "apiKeyEnvVar": "POLICY_INTENT_API_KEY",
    "timeoutMs": 4000,
    "maxContextChars": 24000,
    "jsonResponse": true,
    "temperature": 0
  }
}
```

名称 `semanticFallback` 为兼容旧配置保留。`primary` 每轮先让大模型识别，包含完整目标、当前约束、用户要求及计划上下文；不受规则分值阈值限制。它可纠正规则对任务类型和意图的误判。`fallback` 保持旧行为，只对低分单句补判，不承担多轮任务关系识别。默认 `enabled: false`，只有显式开启后才调用识别服务。旧版没有 source 的配置仍按独立接口解释，避免升级后改变既有服务。

- OpenAI 兼容平台使用 `protocol: "openai"` 和完整 Chat Completions 地址。
- Anthropic 原生 Messages 使用 `protocol: "anthropic"`、`strategy: "primary"` 和完整 `/v1/messages` 地址，密钥环境变量由你指定。
- 本地无认证接口可设置 `apiKeyEnvVar: null`。不支持 JSON 格式或 temperature 的服务分别设置 `jsonResponse: false`、`temperature: null`。

`agent` 来源跟随主模型；`endpoint` 来源独立选择识别模型。启用后会把当前任务上下文发送给对应服务；不发送仓库文件、工具输出、其他会话或完整聊天记录。任务要求原文可能含有用户输入的敏感内容。请求不重试；缺密钥、超时、非法 JSON、枚举错误或上下文超出 `maxContextChars` 时降为规则，并记录原因。超限不偷偷截掉约束。`maxContextChars` 统计序列化上下文的 JavaScript 字符串长度，并非 token 数。

配置独立接口后，用 `/policy recognition endpoint` 切换、`/policy preview --semantic <请求>` 验证来源和阶段，再用 `/policy save global` 保存选择。普通预览不联网。`/policy recognition` 查看最近请求的来源、模型、耗时与降级原因；密钥值不写入诊断。

任务账本保留用户要求的原文及来源。约束提取只是索引，遗漏提取不会删除原要求；后续纠正要结合要求顺序理解，不会由分类模型自动擦除旧记录。长任务的账本会增加注入量，仍需通过真实任务评估成本。

严格规划完成时，模型需附带 `policy-plan` JSON 代码块，内容包含当前任务 ID、计划版本、目标以及带验证项的步骤；系统提示会提供格式。缺少有效报告时保持 `planning / missing_plan`，不能用“好”把普通问答变成已批准计划。报告是模型提出的计划，不代表计划正确，也不证明执行或测试成功。自然语言审批仍使用保守规则；识别模型不能自行授予权限，明确审批可使用 `/policy approve`。

### 模型规则

宿主切换模型后，下一轮会重新计算适配策略。全局配置可补充代理平台或别名规则，用户规则先于包内规则匹配：

```json
{
  "modelRules": [
    { "provider": "my-proxy", "model": "deepseek-*", "policy": "model.deepseek" }
  ]
}
```

`provider` 精确匹配，`model` 支持精确值或尾部 `*` 前缀匹配，均不区分大小写。辅助分类可跟随主模型或独立配置；仅独立接口来源使用下列参数：对不支持特定参数的兼容接口，可设置 `semanticFallback.jsonResponse: false` 或 `semanticFallback.temperature: null`。本扩展不选择主模型、不管理模型实例或队列。

## 开发与文档

在本包目录运行；包要求 Node.js 20 或更高版本，使用纯 JavaScript 和 Node.js 内置模块。

```bash
npm run check
npm test
```

`extensions/policy-engine/` 负责 Pi 生命周期、命令与显示；`src/core/` 保持纯逻辑，不导入 Pi 模块。测试包含规则、状态流转、配置边界和扩展生命周期冒烟检查。

[设计说明](DESIGN.md) · [配置示例](examples/README.md) · [参考来源](SOURCES.md) · [更新记录](CHANGELOG.md)

MIT © huangrx6
