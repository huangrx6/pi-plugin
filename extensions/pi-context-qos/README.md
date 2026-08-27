# pi-context-qos

非破坏式、任务感知、可恢复的 Pi working-context runtime。

Pi Session 始终保留完整、权威的历史；本扩展只在每次调用模型前，通过 Pi 的 `context` hook 动态选择真正进入 Active LLM Context 的 working set。旧工具结果按 `RAW → EXTRACT → SUMMARY → TOMBSTONE` 单向降级，原始证据进入本地 Cold Store，并可通过 `ctx://item/<id>` 随时召回。

## 核心保证

- 不修改 Pi Session，不删除 user message。
- pinned、未解决失败、最新文件版本和 Active Frontier 不自动降级。
- 工具调用与结果始终保持成组，不产生 orphan tool result。
- 每个 item 记录 branch origin；`/tree` 只使用当前 lineage，`/fork` 只继承新分支可见的 metadata。
- representation 只自动向更紧凑的方向变化，避免 provider prompt prefix 每轮抖动。
- 原始内容用 SHA-256 寻址、zstd 压缩并跨 session 去重。
- SQLite 只保存 metadata、确定性摘要与 FTS5 搜索索引，大内容不塞进数据库。
- Cold Store 默认 `0700`，数据库和 blob 为 `0600`；敏感值默认脱敏，排除路径不归档正文。
- QoS 处理后仍超出有效预算时，才触发 Pi 原生 compaction 兜底。

## 运行要求

Node.js `>=22.15`。扩展使用 Node 内置 `node:sqlite`、FTS5 和 zstd，不引入运行时数据库或压缩依赖。

安装整个仓库：

```bash
pi install git:github.com/huangrx6/pi-plugin
```

也可以只安装本目录作为独立 Pi package。安装后重启 Pi 或执行 `/reload`。

## 三个空间

```text
Pi Session（完整权威）
        │ context hook：只处理 deep copy
        ▼
Active LLM Context（每次动态生成，不落盘）
        ▲
        │ summary / ctx:// recall
        ▼
Cold Store（SQLite metadata + CAS zstd blobs）
```

默认数据目录：

```text
~/.pi/agent/context-qos/
├── context.db
├── context.db-wal
├── context.db-shm
├── blobs/
│   └── ab/
│       └── <sha256-rest>.zst
└── config.json
```

项目仓库内只允许策略文件 `<repo>/.pi/context-qos.json`。项目配置仅在 Pi 信任该项目时读取，真实上下文数据不会写进项目。

## 模型工具

- `context_recall({ ref })`：恢复 `ctx://item/<id>` 的原始内容；若原文未归档或已 GC，返回可追溯摘要。
- `context_search({ query, limit? })`：在当前 session branch 的 FTS5 索引中搜索。
- `context_pin({ ref })`：固定 item，阻止后续自动降级。
- `context_unpin({ ref })`：解除固定。

## 用户命令

```text
/context
/context stats
/context top
/context tree
/context tasks
/context epochs
/context inspect <ref>
/context recall <ref>
/context search <query>
/context pin <ref>
/context unpin <ref>
/context gc [--aggressive]
/context freeze
/context unfreeze
/context doctor
/context config
/context reset-session
```

`/context reset-session` 只重置当前 session 的 QoS metadata，不修改 Pi Session，也不直接删除共享 blob；无引用 blob 由 GC 清理。

## 配置

全局配置：`~/.pi/agent/context-qos/config.json`。

项目配置：`<repo>/.pi/context-qos.json`。

```json
{
  "enabled": true,
  "budget": {
    "outputReserveRatio": 0.12,
    "safetyReserveRatio": 0.06,
    "yellow": 0.55,
    "orange": 0.7,
    "red": 0.82,
    "critical": 0.92,
    "nativeCompactFallback": true
  },
  "frontier": {
    "protectedUserTurns": 2,
    "protectedCausalBlocks": 8
  },
  "storage": {
    "directory": "~/.pi/agent/context-qos",
    "maxBytes": 2147483648,
    "maxAgeDays": 30
  },
  "epochs": {
    "maxTurns": 12
  },
  "security": {
    "archiveSecrets": false,
    "excludePatterns": [
      "**/.env",
      "**/*.pem",
      "**/secrets/**"
    ]
  }
}
```

阈值以有效预算计算：`contextWindow - outputReserve - safetyReserve`，不是直接除以模型最大 context window。

## 压力策略

| 区间 | 默认动作 |
| --- | --- |
| Green `<55%` | 去重，已被覆盖内容形成稳定摘要 |
| Yellow `55–70%` | disposable / superseded 转为 extract |
| Orange `70–82%` | historical 与低相关证据转为 extract |
| Red `82–92%` | 低分内容转 summary / tombstone |
| Critical `>92%` | 最大化降级；仍超预算才调用原生 compaction |

评分是可解释的线性组合：task relevance、importance、unresolved、causal dependency、recency、uniqueness、code proximity、verification value；pinned、未解决错误、最新文件快照和 Active Frontier 等 hard rule 永远先于评分。

## 确定性压缩

首版对测试、Git、文件读取、搜索和通用 Bash 输出采用专用确定性提取器。结构化摘要保留 facts、decisions、errors、files、symbols、unresolved 和 next actions。不会把源码或终端输出发送给额外的摘要模型。

## 开发

```bash
npm install
npm run check
npm test
```

`check` 会先按仓库 ambient shim 检查全部源码与测试，再绕过 shim、直接按安装的 Pi 真实类型契约检查 runtime。测试临时数据全部创建在 `os.tmpdir()` 下。
