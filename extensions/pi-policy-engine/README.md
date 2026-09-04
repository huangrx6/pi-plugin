<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/policy-engine.svg" alt="pi-policy-engine" width="48" />
</p>

# pi-policy-engine

<p align="center"><strong>按任务形态路由流程：quick / standard / strict，高风险先计划后审批。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

根据任务长相把「严格流程」指令注入系统提示：模型读到它们、遵守它们、自己停下来——和一个技能说「这里必须暂停问用户」是同一机制。本扩展只作用于任务行为层（系统提示注入 + 流程状态机）；不拦截 `tool_call`，工具权限问题属于权限层，刻意不在范围内。

## 路由

提示词到达时：

```text
prompt
  ↓ 分类器（确定性规则，不调 LLM）
  ↓ 任务 / 风险 / 领域 / 关注点 / 模型 / 用户覆盖
路由
  ├─ Rigor（多严格）  高风险 → strict（计划 + 暂停 + 分波执行）
  │                   低风险 → quick；其余 → standard
  └─ Flow（怎么做）   debugging → debug-first
                      review → review-first；research → research-first
```

两者正交：`debug-first + quick` 与 `debug-first + strict` 都合法。为什么用确定性规则而不是 LLM 分类——**让模型自己决定给自己加什么约束是循环论证**；规则路由快、可审计、不受模型漂移影响。

严格档会在注入的策略里写明：「本轮 PLAN-ONLY……在计划后停下并请求批准，不要在同一轮开始实施」。模型返回任务契约与计划后停止；你回复「开始执行 / 批准 / approve / go ahead」，状态机从 `planning` 转入 `executing`，改注入 strict-execute。计划中途的追问不是批准——状态保持 `planning` 并追加「未获显式批准不得执行」。

### 自主授权

说「不用征求我的意见了 / 构思完就执行 / don't ask me」这类明确授权时，审批门**整个释放**：同一条消息里随后出现的约束（「但别动数据库」）成为执行约束而不是重新上锁；只有整句取消或纠错开头（「不对，改成…」）能撤销释放。v0.24 之前这是一个真实事故：用户留言授权后去睡觉，引擎仍按「修订计划」处理，整夜停在等待批准——回归测试用原话钉住了这条路径。

## 注入记录

每次实际注入发生变化，对话中出现一条简短记录（如 `已注入策略 · 标准流程 · 故障排查`），展开可见触发依据、实际加载的要求、因预算或缺失未加载的项与当时的流程安排；相同注入不重复刷屏。`/policy` 默认解释最近一次行为并显示当前处于执行、计划还是等待确认；`/policy injected` 展示实际追加的完整原文。

记录保存为会话扩展条目，**不进入模型上下文**；它描述提供给模型的要求，不能证明模型已遵守或验证已通过。历史卡片按终端显示宽度换行、用当前主题区分层级，展示前清理控制序列。模式与配置档在「设置」中分别选择，取消静默返回。

## 分类维度

| 维度 | 取值 | 要点 |
| --- | --- | --- |
| 任务 | coding / debugging / review / research / architecture / documentation | 意图框加权：动作从句里的证据双倍计分，背景提及只算一半 |
| 执行意图 | `mutate` / `read-only` / `unclear` | 「不要只分析，直接修改代码」= mutate——否定窗口内的动词是死证据；提及不等于意图 |
| 风险 | high / medium / low | 架构任务默认高风险；强关注点可抬高下限；read-only 意图自动降档 |
| 时机与审批 | `now` / `deferred` · `explicit` / `none` | 「确认后再执行」显式建门，压过自动风险判断；授权短语可解除 |
| 领域 | database / backend / frontend / … | 强信号（`postgres`、`react`、`jwt`）命中即载；弱信号（`组件`、`api`）单独不载，需同域两个或一个框词 |
| 关注点 | security / production / … | 与领域分账，不占 `maxDomains`（默认 2）名额 |

低置信不是遮羞布：候选并列会主动压低置信度，`/policy why` 展示每一次剪裁的理由——**这个扩展的存在意义是减少上下文噪声，它自己就不能制造噪声**。

## 可靠性细节

- **连续性** — 「继续 / 还是不对 / 按这个做」这类裸跟进继承上一轮的任务、领域与关注点，重算意图；风险只升不降（「继续」不会丢掉安全关注点）
- **跨会话恢复** — 未决的严格计划随历史持久化，`session_start` 恢复（同项目目录、7 天内；`/policy cancel` 丢弃）；状态文件按项目目录哈希分片，互不覆盖
- **信任边界** — 项目层 `.pi/policy-engine.json` 只承载路由与行为定制；网络、凭证、文件系统特权键（`semanticFallback`、`historyFile` 等）仅全局生效，项目层写入被丢弃并由 `/policy validate` 报告
- **可选语义回退** — 确定性置信度过低时可启用 OpenAI 兼容的小模型重分类；默认关闭，任何失败静默回退确定性结果，绝不阻塞

## 命令

| 命令 | 行为 |
| --- | --- |
| `/policy` | 本次行为说明 + 当前流程状态；设置在次级入口 |
| `/policy auto\|quick\|standard\|strict\|off` | 切换运行时模式 |
| `/policy once <mode>` | 仅下一轮使用指定模式 |
| `/policy profile <name>` | 切换配置档（coding / debugging / …） |
| `/policy preview <prompt>` | 干跑路由：不发送、不改状态、不调用回退 |
| `/policy diff <A> \|\| <B>` | 对比两条提示词的路由差异 |
| `/policy why` / `/policy injected` | 触发依据与实际注入原文 |
| `/policy history [N\|clear-disk]` | 最近 N 条路由决策；可清空磁盘历史 |
| `/policy config` / `/policy validate` | 解析后的完整配置 / 配置校验 |
| `/policy status` / `/policy cancel` / `/policy reset` | 当前状态 / 取消未决计划 / 清除运行时覆盖 |

## 配置

优先级：包默认 → `~/.pi/agent/policy-engine.json`（全局）→ `<project>/.pi/policy-engine.json`（项目）→ `/policy` 运行时覆盖。

```json
{
  "mode": "auto",
  "profile": "auto",
  "domainHints": ["backend"],
  "includePolicies": [],
  "historyFile": "~/.pi/agent/policy-engine/history.jsonl"
}
```

项目层额外支持 `projectPolicies`：默认扫描 `.pi/policies/**/*.md`（上限 12 文件 / 24 KB）；多个策略文件时可用 `manifest.json` 按维度条件加载（任务 × 领域跨维 AND、维内 OR，路径仅限 `.pi/policies/` 内且经符号链接校验）。

全局可复用策略：写入 `policies/<layer>/<name>.md` 并在 `policies/manifest.json` 注册，再挂到某个 `profiles/<name>.json` 或 `includePolicies`。路由关键词在 `config/routing.json` 中纯数据驱动，无需改分类器代码。

## 边界

```text
AGENTS.md         = 常驻的项目 / 全局小宪法
Skill             = 具体能力怎么做（迁移、画图……）
pi-policy-engine  = 动态行为规则 + 严格度 / 流程路由 + 模型 / 领域适配
```

本扩展不替代前两者，也不假设它们存在。

## 已知限制

- 分类器是规则而非语义模型；神秘提示词可开启可选语义回退（需网络 + API Key，离线场景不适用）
- 严格审批是软约束：模型被告知要停，不是被机械阻止；工具级强制由宿主负责
- `/policy` 运行时覆盖是进程内的；持久化走全局 / 项目配置文件

## 安装

```bash
pi install git:github.com/huangrx6/pi-plugin
```

重启 Pi 或执行 `/reload`。零运行时依赖（纯 JS + Node 内置模块）。

## 开发

```bash
cd extensions/pi-policy-engine
npm run check                 # node --check 覆盖全部源文件（glob）
npm test                      # 单元 + 回归 + self-test + 生命周期冒烟
```

`src/core/` 不 import 任何 pi 模块——纯函数、独立可测。

<details>
<summary>文件结构</summary>

```text
pi-policy-engine/
├── extensions/policy-engine/   # Pi 扩展装配（lifecycle / commands / format）
├── src/core/                   # 纯逻辑：classifier / router / approval /
│                               # intent / matcher / loader / config /
│                               # semantic / history-store
├── policies/                   # Markdown 策略（core / behaviors / flows /
│                               # rigors / domains / concerns / models）+ manifest
├── profiles/                   # 配置档 JSON
├── config/                     # defaults.json + routing.json（数据驱动关键词）
├── examples/ · scripts/ · tests/
```

</details>

## License

MIT © huangrx6
