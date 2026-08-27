# Changelog

## 0.1.5 - 2026-08-27

- Status moves to the `context:qos` key and renders as one compact line in the quota-status idiom — `⚡QoS 22%(绿) 活179k 省22.9k 库165项` — with trailing-zero-free token counts and the frozen marker folded into the level bracket (`(绿·冻结)`). Cold-store bytes leave the footer (still in `/context stats`). Multi-row footers place it in a context-governance row; single-line renderers show it inline.

## 0.1.4 - 2026-08-27

- Publish the footer status at `session_start` too, not only before each model call. Previously the status stayed invisible until the first user turn (the `context` hook never fires without a model call); on a resumed session the line now shows archived-item state immediately, and on a fresh session it shows a zeroed line proving the runtime is alive.

## 0.1.3 - 2026-08-27

- Footer status now renders as two stacked lines — `QoS 上下文X%级 · 活… · 省…` / `N项 · 冷… · 冻结…` — so it no longer stretches the resources row it lands in. Aggregators that support multi-line cells render one sub-line per display row; single-line renderers flatten the newline to a space.

## 0.1.2 - 2026-08-27

- Publish a one-line footer status under the `usage:context-qos` key after every model call: Chinese-labelled fields (`上下文`/`活`/`省`/`项`/`冷`), a pressure-colored percentage (green/yellow/orange/red, bold red for critical), and a `冻结` marker while frozen. Any status aggregator routing `usage:*` keys renders it in its resources row; the extension remains unaware of who consumes it.

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
