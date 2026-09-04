<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-policy-engine</h1>

<p align="center">按任务选择执行流程，并让每一次策略注入都可解释、可核对。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

为 Pi 的编码、排障、审查和调研任务追加适用的执行要求。默认使用确定性规则选择流程；你可以直接查看为什么触发、加载了什么，以及当前是否在等待确认。

## 快速开始

在本扩展包目录中执行，单独安装此扩展：

```bash
pi install "$PWD"
```

重启 Pi 或执行 `/reload`，发送一个任务，再输入 `/policy` 查看本次行为。默认 `auto` 模式，无需配置，也不需要额外 API Key。

## 实际体验

**任务决定流程。** 简单任务走 `quick`，常规工作走 `standard`，高风险或明确要求确认的工作进入 `strict`。排障、审查和调研还会叠加各自的处理顺序；严格度与任务流程分别判断。

**变化留下记录。** 实际注入内容变化时，对话中显示一条策略摘要。展开后可查看触发依据、已加载要求、因预算或缺失未加载的项，以及当时的流程安排。重复注入不会反复刷屏，历史卡片不会随新任务改写。

**详情随时可查。** `/policy` 首先提供本次行为和注入原文，模式与配置档放在次级设置中。显示使用当前终端主题，中文与 emoji 按显示宽度换行；取消选择静默返回。

| 模式 | 提供给模型的要求 |
| --- | --- |
| `auto` | 根据任务自动选择严格度，默认模式 |
| `quick` | 简短检查、修改和验证 |
| `standard` | 明确任务，检查、计划、执行并验证 |
| `strict` | 先交付计划并等待确认，再分步执行 |
| `off` | 关闭策略注入与模型适配 |

严格流程中，补充或修订计划通常继续等待确认；明确批准后进入执行。对于实现能识别的自主授权表达，例如「构思完就执行，不用征求我的意见了」，会释放审批等待，并保留附带的执行约束。

> 策略通过系统提示约束模型，不拦截工具调用。注入记录证明的是“模型收到了什么要求”，不能证明模型已经遵守，也不能代替工具权限控制。

## 日常命令

通常只需记住 `/policy`；以下入口适合直接操作。

| 命令 | 用途 |
| --- | --- |
| `/policy` | 查看本次行为、注入原文或打开设置 |
| `/policy why` | 触发依据、实际要求与当前流程状态 |
| `/policy injected` | 查看最近实际追加的完整指令 |
| `/policy quick` | 本次运行切换为快速模式；也支持其余模式名 |
| `/policy once strict` | 仅下一次策略决策使用指定模式 |
| `/policy cancel` | 取消未决严格计划，不会中止正在运行的模型 |
| `/policy reset` | 清除运行时覆盖与未决计划，重新使用文件配置 |

<details>
<summary>诊断与路由调试</summary>

| 命令 | 用途 |
| --- | --- |
| `/policy profile <name>` | 选择 `auto`、`coding`、`debugging`、`documentation`、`architecture`、`review` 或 `research` |
| `/policy preview <prompt>` | 预览路由，不发送给主模型、不推进执行阶段；会记录预览历史 |
| `/policy diff <A> \|\| <B>` | 比较两条提示词的路由结果 |
| `/policy history [N]` | 查看最近的路由记录，默认 5 条 |
| `/policy history clear-disk` | 清空配置的磁盘历史及当前内存历史 |
| `/policy config` | 查看合并后的配置 |
| `/policy validate` | 校验配置与策略引用 |
| `/policy status` | 查看模式、配置档和流程状态 |

`preview` 与 `diff` 使用确定性路由，不调用可选语义回退。

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

默认最多选择 2 个领域，策略总预算为 24,000 字节；项目策略另有最多 12 个文件、24,000 字节的上限，仍受总预算约束。缺失或被截断的策略会反映在行为说明中。

设置 `PI_CODING_AGENT_DIR` 后，全局配置与数据使用该目录下的 `extensions-data/pi-policy-engine/`。新配置不存在时回读旧的 `policy-engine.json`；新 `state/` 不存在时沿用旧的 `policy-engine/` 数据目录。配置与状态分别判断，运行时不自动移动文件；显式配置的 `historyFile` 优先。

运行时模式和配置档不写回配置文件。路由历史默认写入 `~/.pi/agent/extensions-data/pi-policy-engine/state/history.jsonl`，其中包含任务提示词；未决严格计划按项目目录隔离保存，同目录、7 天内可恢复。对话中的活动卡片属于会话扩展记录，不进入模型上下文。

<details>
<summary>自定义策略与可选语义回退</summary>

包内 `policies/manifest.json` 管理策略索引，`profiles/` 组织配置档，`config/routing.json` 管理路由关键词。项目规则可先参考本包的[配置示例](examples/README.md)，使用 `/policy preview` 和 `/policy validate` 核对效果。

规则分类可能误判模糊表达。全局配置可启用 `semanticFallback`，在低置信度时调用 OpenAI 兼容接口重新分类；默认关闭，调用失败保留确定性结果。启用后会向所配服务发送用于分类的任务内容。

网络端点、凭证来源、历史路径等受信任设置只能从全局配置生效。项目层的对应键会被丢弃，`/policy validate` 会报告原因。

</details>

## 开发与文档

在本包目录运行；包要求 Node.js 20 或更高版本，使用纯 JavaScript 和 Node.js 内置模块。

```bash
npm run check
npm test
```

`extensions/policy-engine/` 负责 Pi 生命周期、命令与显示；`src/core/` 保持纯逻辑，不导入 Pi 模块。测试包含规则、状态流转、配置边界和扩展生命周期冒烟检查。

[设计说明](DESIGN.md) · [配置示例](examples/README.md) · [参考来源](SOURCES.md) · [更新记录](CHANGELOG.md)

MIT © huangrx6
