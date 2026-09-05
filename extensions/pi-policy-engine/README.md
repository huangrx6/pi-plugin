<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-policy-engine</h1>

<p align="center">按任务选择执行流程，并让每一次策略注入都可解释、可核对。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

为 Pi 的编码、排障、审查和调研任务追加适用的执行要求。当前 agent 默认在用户消息显示后先完成一次结构化意图识别，插件再依据结果选择流程、领域和模型适配，然后继续正式回答。你可以查看判断方式、加载的要求，以及当前是否在等待确认。

## 快速开始

在本扩展包目录中执行，单独安装此扩展：

```bash
pi install "$PWD"
```

重启 Pi 或执行 `/reload`，发送一个任务，再输入 `/policy` 查看本次行为。默认 `auto` 模式，无需配置，也不需要额外 API Key。

## 实际体验

**任务决定流程。** 简单任务走 `quick`，常规工作走 `standard`，高风险或明确要求确认的工作进入 `strict`。排障、审查和调研还会叠加各自的处理顺序；严格度与任务流程分别判断。

**变化留下记录。** 实际注入内容变化时，对话中显示一条策略摘要。展开后可查看触发依据、已加载要求、因预算或缺失未加载的项，以及当时的流程安排。重复注入不会反复刷屏，历史卡片不会随新任务改写。中断后输入“继续”，或宿主用原消息自动重试，仍会由当前模型确认意图；如果策略没有变化，只复用原策略，不新增相同活动卡片。

**详情随时可查。** `/policy` 只有一级日常面板：查看状态、自动处理、谨慎处理、审批当前计划、结束当前任务、检查配置和关闭策略。选中模式后立即保存，无需再执行保存命令。需要参数的诊断命令不占用面板位置。

| 模式 | 提供给模型的要求 |
| --- | --- |
| `auto` | 根据任务自动选择严格度，默认模式 |
| `quick` | 简短检查、修改和验证 |
| `standard` | 明确任务，检查、计划、执行并验证 |
| `strict` | 先交付计划并等待确认，再分步执行 |
| `off` | 关闭策略注入与模型适配 |

问候和感谢不追加工程策略，也不改变当前任务。新的独立请求重新分类；全面只读审查会增加覆盖清单，不要求实施审批。

自动模式按四个正交维度组合策略：意图决定能否修改，风险决定安全边界，覆盖范围决定流程深度，任务类型决定工作顺序。聚焦且低风险的修改进入 `quick`；普通或范围较大的任务进入 `standard`；高风险修改、明确要求审批或仍无法确认执行意图的任务进入 `strict`。只读任务不会因为严格模式伪造批准计划；审查、排障和调研分别加载自己的工作顺序。

严格流程中，修改计划通常继续等待确认；明确批准后进入执行。“批准，但别动数据库”等可识别的范围限制会保留为执行约束。对于实现能识别的自主授权表达，例如「构思完就执行，不用征求我的意见了」，会释放审批等待，并保留附带的执行约束。

> 策略通过系统提示约束模型，不拦截工具调用。注入记录证明的是“模型收到了什么要求”，不能证明模型已经遵守，也不能代替工具权限控制。

## 日常操作

只需记住 `/policy`。面板会根据当前任务动态显示可用操作。

| 面板选项 | 作用 |
| --- | --- |
| 查看本次状态 | 当前流程、判断方式、实际注入要求和下一步 |
| 自动处理（推荐） | 当前模型先结合完整对话识别意图，再选择对应流程；立即保存 |
| 谨慎处理 | 所有修改先给计划并等待确认；立即保存 |
| 批准当前计划 | 仅在存在有效待审批计划时显示，只批准当前版本 |
| 结束当前任务 | 清除任务关联，让下一条请求重新开始 |
| 检查配置 | 显示个人配置文件路径和校验结果 |
| 关闭策略 | 停止注入并立即保存 |

<details>
<summary>诊断与路由调试</summary>

| 命令 | 用途 |
| --- | --- |
| `/policy preview <prompt>` | 使用当前上下文副本预览；`--new` 从新任务开始，`--semantic` 显式允许已配置的模型识别 |
| `/policy diff <A> \|\| <B>` | 比较两条提示词的路由结果 |
| `/policy history [N]` | 查看最近的路由记录，默认 5 条 |
| `/policy history clear-disk` | 清空配置的磁盘历史及当前内存历史 |
| `/policy config` | 查看合并后的配置 |
| `/policy validate` | 校验配置与策略引用 |
| `/policy status` | 查看模式、配置档和流程状态 |
| `/policy reset` | 清除运行时覆盖与当前任务，重新读取文件配置 |

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

设置 `PI_CODING_AGENT_DIR` 后，全局配置与数据固定使用该目录下的 `extensions-data/pi-policy-engine/`；运行时不再读取旧的散落配置或状态目录。显式配置的 `historyFile` 优先。

在面板选择自动、谨慎或关闭后，会立即原子写入全局个人配置。`/policy config` 显示合并值及来源，结构错误由 `/policy validate` 报告；运行中配置损坏时保留最后有效配置并提示。路由历史默认写入 `~/.pi/agent/extensions-data/pi-policy-engine/state/history.jsonl`，其中包含最多 80 字符的输入摘要及任务、会话、阶段、模型和指纹信息。识别失败还会记录尝试次数、解析或结构校验阶段、响应长度和最多 240 字符的响应预览；`/policy history [N]` 可直接查看，面板中的“检查配置”会显示实际日志路径。正常恢复优先使用同会话当前分支的工作流记录，并核对计划条目；磁盘后备状态按项目和会话隔离，最多恢复 7 天内记录。过期或旧格式审批状态会被忽略，不参与新会话恢复。对话中的活动卡片和工作流记录不进入模型上下文。

安装目录中的 `config/defaults.json` 是随代码发布的内置默认值，不保存用户选择。个人配置固定写入 `<agent-dir>/extensions-data/pi-policy-engine/config.json`；默认 `<agent-dir>` 为 `~/.pi/agent`，因此通常路径是 `~/.pi/agent/extensions-data/pi-policy-engine/config.json`。设置 `PI_CODING_AGENT_DIR` 时，路径跟随该目录。

回合结束只表示本轮停止：结果可标为等待批准、失败、中断、缺少计划或未验证。插件不会因为 `agent_end` 就宣称测试通过或任务已验证完成。

<details>
<summary>自定义策略</summary>

包内 `policies/manifest.json` 管理策略索引，`profiles/` 组织配置档，`config/routing.json` 管理路由关键词。项目规则可先参考本包的[配置示例](examples/README.md)，使用 `/policy preview` 和 `/policy validate` 核对效果。

正式运行由模型完成关系、意图、风险、领域和覆盖范围识别；确定性规则只用于离线预览、审批解析和模型结果后的流程组合，不作为在线意图回退。

网络端点、凭证来源、历史路径、模型匹配规则等受信任设置只能从全局配置生效。项目层的对应键会被丢弃，`/policy validate` 会报告原因。

</details>

### 当前模型理解意图

默认由当前 agent 在正式回答前完成一次独立的结构化意图识别，再由插件选择对应的意图、流程、风险和领域策略。这次调用复用当前模型及宿主认证，携带经过长度限制的近期对话和任务快照，不提供工具，也不能授予审批权限。用户消息会先进入对话，Pi 自带的 Working 行显示“意图识别中…”，识别结束后恢复 Pi 的默认 Working 文案，再继续正式回答。

需要单独使用其他识别模型时，可以在全局 `config.json` 中配置高级 endpoint 模式：

```json
{
  "recognition": {
    "enabled": true,
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

`recognition` 是当前识别配置块的固定键名；它不再表示“规则回退”。`source: "agent"` 使用当前 Pi 模型，`source: "endpoint"` 使用独立网络服务。两种来源都必须在正式运行中返回有效识别结果。

- 当前 agent 模式复用 Pi 当前模型、认证和平台适配，不需要填写模型名或 API Key。
- OpenAI 兼容平台使用 `protocol: "openai"` 和完整 Chat Completions 地址。
- Anthropic 原生 Messages 使用 `protocol: "anthropic"` 和完整 `/v1/messages` 地址，密钥环境变量由你指定。
- 本地无认证接口可设置 `apiKeyEnvVar: null`。不支持 JSON 格式或 temperature 的服务分别设置 `jsonResponse: false`、`temperature: null`。

只有 `endpoint` 来源会把当前任务摘要发送给所配服务；它不发送仓库文件、工具输出、其他会话或完整聊天记录。任务要求原文可能含有用户输入的敏感内容。JSON 或结构校验失败时，会在同一总时限内使用相同来源做一次仅修复格式的调用；网络错误、缺密钥、超时和上下文超限不重试。最终仍不合格时，本轮不加载任务策略，并给主模型追加停止执行与请用户重试的要求。插件通过提示约束主模型，不拦截工具调用。

独立 endpoint 是高级配置能力，不出现在日常面板。可以用 `/policy preview --semantic <请求>` 验证，普通预览不联网；密钥值不写入诊断。

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

`provider` 精确匹配，`model` 支持精确值或尾部 `*` 前缀匹配，均不区分大小写。识别可以跟随主模型，也可以配置独立 endpoint；仅独立接口来源使用下列参数：对不支持特定参数的服务，可设置 `recognition.jsonResponse: false` 或 `recognition.temperature: null`。本扩展不选择主模型、不管理模型实例或队列。

## 开发与文档

在本包目录运行；包要求 Node.js 20 或更高版本，使用纯 JavaScript 和 Node.js 内置模块。

```bash
npm run check
npm test
```

`extensions/policy-engine/` 负责 Pi 生命周期、命令与显示；`src/core/` 保持纯逻辑，不导入 Pi 模块。测试包含规则、状态流转、配置边界和扩展生命周期冒烟检查。

[设计说明](DESIGN.md) · [配置示例](examples/README.md) · [参考来源](SOURCES.md) · [更新记录](CHANGELOG.md)

MIT © huangrx6
