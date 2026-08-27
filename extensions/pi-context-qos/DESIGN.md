# pi-context-qos design

## Boundary

本扩展只管理当前 session/task 的 Active LLM Context 生命周期，不承担跨 session 的长期工程记忆，也不依赖任何其他扩展的代码、事件、命令或数据。

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
