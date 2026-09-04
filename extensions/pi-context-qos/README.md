<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/context-qos.svg" alt="pi-context-qos" width="48" />
</p>

# pi-context-qos

<p align="center"><strong>非破坏性的工作区上下文维护：可降级、可召回、可恢复。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.15-4c1?style=flat-square" />
</p>

Pi 的只读追加会话始终是权威。本扩展把工具证据归档进 SQLite/FTS5 元数据索引与内容寻址的 zstd 冷库，再通过 `context` 钩子为旧的工具结果选择 `RAW → EXTRACT → SUMMARY → TOMBSTONE` 表示。最新的因果前沿、用户消息、固定项、未解决失败与当前文件快照被硬保护；被改写的只有深拷贝的工具结果文本，用户 / 助手 / 工具调用形状从不改动。

当降级仍装不进预算时，回退调用 Pi 内置压缩，并带上保留当前目标、未解决证据与 `ctx://` 召回引用的指令。扩展触发的整理成功后，被中断的任务会收到一次续跑请求；取消、失败、会话或分支变化、更新的输入都会阻止这次续跑。

## 日常使用

`/context` 查看自动管理状态、有效预算占用、压缩阈值与最近一次整理结果；首层菜单提供用量、暂停 / 恢复、仅本会话的阈值调整与高级操作。整理结果以可展开条目出现在对话中——这些条目不进入模型上下文，使用当前终端主题按字素宽度换行，且冻结为不可变的历史快照。

```text
/context                  状态总览 + 日常操作
/context stats            详细压力统计
/context threshold 60     仅本会话的临界阈值（有效预算口径）
/context recall <ref>     召回原始内容
/context search <query>   FTS 检索
/context pin / unpin <ref> 固定 / 取消固定
/context gc / freeze / unfreeze / doctor / config
```

## 召回闭环

工具结果被降级后，替换文本自带恢复指令：

```text
[bash archived · restore: context_recall(ctx://item/123)]
```

模型看到桩后需要证据时，直接调用唯一的模型工具 `context_recall({ ref })` 把原文重新注入当前前沿——从不改写冻结的历史前缀。`/context search|pin|unpin` 仍是用户命令。

早期版本验证过一个反直觉事实：17 个会话、4482 个条目、56% 被 tombstone，而旧版哑桩 `[bash archived: ctx://item/N]` 从未被召回过一次——桩不说能恢复，模型就不会恢复。自描述桩与单一工具就是为此而设。

## 核心保证

- **非破坏** — Pi 会话 JSONL 从不被写入或改写
- **硬保护** — 固定项、未解决失败、最新文件快照、活跃因果前沿与用户消息从不自动降级
- **因果完整** — 工具调用与结果永远成对；规划器只替换结果文本的表示
- **表示单调** — 自动变更只会更紧凑；冻结的历史前缀不会被重新展开
- **分支谱系** — 每个条目携带 `origin_entry_id`；`/tree` 只加载当前分支可见项，`/fork` 只继承新分支可见的元数据
- **内容寻址** — 原文 SHA-256、zstd 压缩、跨会话去重
- **紧凑权限** — 存储根 `0700`、库与 blob `0600`；密钥默认脱敏；排除路径不存正文也不进搜索索引
- **最后手段** — 仅当临界级降级后压力仍不低于临界阈值才调用内置压缩

## 压力策略

压力按**有效预算**（`contextWindow − 输出预留 − 安全预留`）计算，阈值默认 `55 / 70 / 82 / 92`%，逐级加深降级；保留分是任务相关性、重要性、未解决、因果依赖、新近度、唯一性、代码邻近与验证价值的可解释线性组合，硬规则始终压过分数。

```json
{
  "budget": {
    "yellow": 0.55, "orange": 0.7, "red": 0.82, "critical": 0.92,
    "nativeCompactFallback": true
  },
  "storage": { "directory": "~/.pi/agent/context-qos", "maxAgeDays": 30 },
  "security": { "excludePatterns": ["**/.env", "**/*.pem"] }
}
```

阈值需在 `(0, 1)` 内严格递增。`/context threshold 60` 只调当前会话并按比例缩放下层阈值，不改配置文件。扩展触发的压缩只获得一次续跑请求，压力未降到阈值以下或不开启新用户请求就不会再次触发；用户主动 `/compact` 不自动续跑。

## 安全

存储根与 blob 分片 `0700`，SQLite 与 blob 文件 `0600`；常见令牌 / 密码 / 私钥 / DSN 在落盘前脱敏；排除路径只保存哈希与「未归档」桩；项目配置仅在 `ctx.isProjectTrusted()` 时加载；GC 只清理本扩展数据。

## 数据布局

```text
~/.pi/agent/context-qos/
├── context.db          # 元数据 + 确定性摘要 + FTS5（不含脱敏原文）
└── blobs/ab/<hash>.zst # 内容寻址冷库
```

项目仓库只能携带策略文件 `<repo>/.pi/context-qos.json`，真实数据不写进项目。压缩器覆盖 tests / git / 文件读取 / 搜索 / 通用 Bash，结构化摘要保留事实、决策、错误、文件、符号与下一步；不向任何外部摘要模型发送源码或终端输出。

## 安装与开发

要求 Node `>=22.15`（`node:sqlite`、FTS5、zstd 均为内置）；无外部服务。

```bash
pi install git:github.com/huangrx6/pi-plugin
```

```bash
cd extensions/pi-context-qos
npm run check      # 双通道类型检查：ambient shim + 真实 pi 类型
npm test           # 单元 + 生命周期冒烟（fixture 全在 os.tmpdir()）
```

<details>
<summary>文件结构</summary>

```text
pi-context-qos/
├── index.ts                    # 扩展装配 + 生命周期接线
├── src/
│   ├── types.ts / config.ts    # 领域类型 / 默认值与合并校验
│   ├── compressors/            # tests / git / read / grep / bash
│   ├── runtime/                # controller / context / planner / scorer /
│   │                           # pressure / archive / tokens /
│   │                           # continuation / terminal
│   ├── security/redaction.ts   # 密钥识别 + 路径排除
│   └── storage/                # database / blob-store / gc
└── tests/                      # core / extension / continuation / terminal
```

</details>

## License

MIT © huangrx6
