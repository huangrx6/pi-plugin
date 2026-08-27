# Changelog

## 0.1.1 - 2026-08-27

- Fix native compaction fallback trigger: `overBudget` compared post-plan tokens against the raw effective budget (ratio > 100%), which made the configured critical threshold meaningless — a session could sit at critical pressure (for example 70% with `critical: 0.6`) without the fallback ever firing. The trigger is now the critical threshold itself: run critical-level degradation first, then fall back to native compaction when post-plan pressure is still at or above critical.
- The disabled/frozen early-return path uses the same fallback semantics.
- Add a regression test that fails on the old comparison.

## 0.1.0 - 2026-08-27

- 建立非破坏式 Context QoS runtime 与压力分区 planner。
- 增加 SQLite/FTS5 metadata、SHA-256 CAS 与 zstd Cold Store。
- 增加测试、Git、read、grep/find/ls 和 Bash 确定性压缩器。
- 增加 Active Frontier、pin、unresolved、最新文件版本和 branch hard protection。
- 增加 `context_recall`、`context_search`、`context_pin`、`context_unpin` 模型工具。
- 增加 `/context` 状态、检查、召回、搜索、GC、freeze、doctor 与 reset 命令。
- 增加 secret redaction、archive exclude、权限收紧与容量/过期 GC。
- 增加 epoch checkpoint、`/tree` lineage 过滤、`/fork` metadata 继承和原生 compaction 兜底。
