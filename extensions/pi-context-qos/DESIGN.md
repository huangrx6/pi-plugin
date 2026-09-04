# pi-context-qos design

## Boundary

本扩展只管理当前 session/task 的 Active LLM Context 生命周期，不承担跨 session 的长期工程记忆，也没有外部运行时依赖。

权威数据始终是 Pi Session JSONL。SQLite 与 blob 都是可丢弃、可重建的派生层；任何 QoS 故障都不得破坏 session。

## Runtime flow

```text
tool_result
  → normalize text
  → SHA-256 original
  → security decision / redact
  → deterministic tool compressor
  → zstd CAS archive
  → SQLite metadata + FTS5

context
  → refresh active branch lineage
  → estimate effective pressure
  → protect user/frontier/pin/unresolved/latest-file
  → calculate explainable retention score
  → choose monotonic representation
  → replace only the deep-copied tool-result text
  → return messages to Pi
  → native compact only when still over budget
```

## Maintenance continuation

Pi 的 `ctx.compact()` 使用手动压缩路径，先中止当前 agent run，完成后不自行恢复。扩展只接管自己在 `context` 边界发起的压缩：记录目标、session ID 与 generation，成功后在同一会话空闲且没有待处理消息时，发送一次隐藏的 custom message 请求继续未完成步骤。它不会触发 `before_agent_start`，因此不会把自身恢复视为新的用户目标。

新用户输入、会话/分支切换、模型选择、暂停管理或关闭使旧回调失效。失败和取消不续跑；压力必须回到阈值以下才能再次自动整理，避免压缩无效时循环。恢复消息只要求模型依据压缩摘要和用户约束继续，不代表扩展能验证模型不重复执行；模型执行行为仍由宿主负责。

宿主在原 run 结束时清理动态 system prompt override，但 agent state 和下一轮请求快照的更新时间不同，不能把完成回调的 `getSystemPrompt()` 视为基础提示。新 runtime 的 `session_start` 先捕获基础提示，压缩请求时再捕获有效提示，移除共同的完整行前缀/后缀，将原生效指令的变化片段放进隐藏恢复消息。reload 或模型变化使基线不可靠时，保留完整有效指令，接受额外 token 成本来避免丢约束。此过程不重新触发用户目标入场，也不读取外部运行时状态。恢复沿用当前系统提示；这段记录用于保留任务执行约束，不能提升其消息优先级。

整理结果通过 `appendEntry` + `registerEntryRenderer` 保存在对话内，可展开前后 token 估算，不进入 LLM 上下文。记录对象在写入时冻结，之后的运行时状态不能改写历史事实。渲染先移除终端与双向文本控制字符，再按 grapheme 显示宽度处理中文、emoji 和组合字符，最后应用宿主主题。`/context` 默认展示使用情况、暂停/恢复、本会话阈值和高级入口，状态栏只是可选摘要。未知占用不能冒充 0%；本会话阈值按比例调整前置降级阈值，不写配置文件。

## Data model

`sessions` 记录 Pi session path、project root、model、window、turn、freeze 和当前 epoch。

`tasks` 记录当前用户 objective。它是 extension 内部的轻量任务模型，不读取外部待办系统。

`epochs` 以固定 turn 数关闭并冻结摘要。冻结摘要不会自动重写。

`context_items` 记录 tool call、branch origin、文件、hash、token、tier、representation、score、pin/unresolved/superseded/duplicate 和结构化摘要。

`blobs` 记录 CAS hash、压缩大小和访问时间；物理内容位于 `blobs/<prefix>/<hash-rest>.zst`。

`context_fts` 是 metadata/摘要的 FTS5 索引，不索引未脱敏原文。

## Tier and representation

Tier 表示用途：`PINNED / WORKING / EVIDENCE / HISTORICAL / DISPOSABLE`。

Representation 表示发送给模型的形态：`RAW / EXTRACT / SUMMARY / TOMBSTONE`。

两者独立。representation 的自动变化是单向、单调的；`context_recall` 通过一个新的 tool result 把 raw 内容重新放入 Active Frontier，而不是改写冻结的历史前缀。

## Causal safety

planner 从不删除 assistant、user 或 tool-result message。它只替换旧 tool-result 的文本表示，因此原有 assistant tool call 与 tool result 仍成组存在。

Active Frontier 同时按最近 user turn 与最近 causal blocks 计算。两者中更早的边界之后都保持原样。

## Branch and fork

每个 context item 保存产生工具调用时的 `origin_entry_id`。`/tree` 后仅加载当前 `getBranch()` 可见的 origin。

`/fork` 创建新 session 时，根据 `previousSessionFile` 复制当前新分支可见的 metadata；blob hash 继续共享，item ID 与 `ctx://` ref 在新 session 中重新生成，避免 session 间 visibility 串联。

## Security

1. storage root 与 blob shard 为 `0700`。
2. SQLite 与 blob 文件为 `0600`。
3. 默认识别常见 token、密码、私钥与 DSN 并在落盘前脱敏。
4. 排除路径只保存 hash 和“未归档”摘要，不保存正文或正文搜索索引。
5. 项目配置只在 `ctx.isProjectTrusted()` 为真时加载。
6. GC 只操作 QoS 派生数据，不接触 Pi Session。

## Invariants covered by tests

- context input deep copy 不被原地修改。
- user message 保留。
- Active Frontier 保持 raw。
- branch 不串 item。
- zstd CAS 去重且可完整恢复。
- secret 脱敏、排除路径不归档。
- 测试失败保持 unresolved evidence。
- 新文件版本 supersede 旧版本，相同版本 deduplicate。
- FTS5 只搜索派生 metadata/summary。
- extension lifecycle、工具、命令与 checkpoint 可完成 smoke run。

## Pi API contract

实现针对 Pi `0.84.x` 的扩展契约：`context`、`tool_result`、`session_start`、`session_tree`、`session_compact`、`getContextUsage()`、`ctx.compact()` 和 `pi.appendEntry()`。运行时只对 `context` 提供的 message deep copy 返回替换值。
