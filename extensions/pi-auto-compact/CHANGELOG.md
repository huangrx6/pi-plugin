# Changelog

## 0.4.0 - 2026-09-04

- Breaking: rename the package to `pi-auto-compact` and reduce its scope to configurable native compaction with automatic continuation.
- Remove the archive database, compressed body storage, context rewriting, recall tool, and archive/search/pin/GC commands. No extension-owned state is written.
- Keep `/context` focused on usage, pause/resume, and threshold. Show unknown usage, pending compaction and failures explicitly.
- Use full-model-window percentages, with a fresh default of 60%. Translate legacy effective-budget settings to preserve the previous trigger; disabling native fallback remains disabled.
- Read global `extensions-data/pi-auto-compact/config.json` and trusted project `.pi/auto-compact.json`, with read-only compatibility for legacy configuration.
- Preserve one-time continuation, execution constraints, cancellation and new-input precedence. Add configuration, no-op loop and in-flight setting-change regressions alongside real offline SDK lifecycle checks.

---

The entries below describe historical `pi-context-qos` releases. Their archive features and old commands are not part of the current package.

## 0.3.3 - 2026-09-04

- Separate global configuration and persistent archives under `extensions-data/pi-context-qos/`, respecting `PI_CODING_AGENT_DIR`.
- Keep legacy paths readable until offline migration; preserve explicit custom archive directories.
- Remove the unnecessary storage path from the common configuration example and document why archives remain persistent.

## 0.3.2 - 2026-09-04

- Replace the advanced command catalog with a paginated current-branch archive picker and per-item preview/pin actions. Diagnostics have a separate entry.
- Reject prose as an archive reference, handle missing and stale refs without uncaught command errors, and let reference commands without arguments open the archive picker.
- Document that user recall only previews content; model context recovery uses the existing `context_recall` tool.

## 0.3.1 - 2026-09-04

- 按实际终端显示宽度渲染整理记录和召回工具摘要，正确处理中文、emoji 与组合字符，并使用宿主主题区分成功、失败和详情。
- 命令通知、工具参数、整理错误和归档内容在展示前移除终端控制序列与双向文本控制字符。
- 整理记录冻结为不可变历史快照；`/context stats` 使用更清晰的中文信息层级。移除不再需要的直接 TUI 依赖。

## 0.3.0 - 2026-09-04

- Resume an active task once after successful extension-triggered compaction, while giving new input, session changes and cancellation priority. Failed or ineffective maintenance does not loop automatically.
- Preserve the interrupted task's effective instruction changes in the hidden continuation, without retriggering user-goal entry. When the base prompt is unknown after reload/model changes, retain the complete effective instructions.
- Record expandable maintenance outcomes in the conversation without adding the activity entries to model context.
- Simplify `/context` to usage, pause/resume, a session-only effective-budget threshold, and advanced operations. Keep existing direct commands available and make reserve/threshold semantics explicit.
- Add installed-SDK lifecycle coverage with an offline model stream and deterministic compaction, alongside cancellation, stale callback and queued-input regressions.

## 0.2.0

### The recovery loop becomes self-teaching (and sheds dead weight)

**Live evidence that drove this release:** across 17 real sessions / 4482
archived items / 2517 tombstones, the model invoked `context_recall`
**zero** times and `context_search`/`context_pin`/`context_unpin` zero
times. Two causes, both fixed:

1. **Stubs were mute.** A tombstone rendered as
   `[bash archived: ctx://item/123]` — a bare ref with no recovery
   path, so the model never learned it could restore evidence. Stubs
   are now self-describing:
   - tombstone → `[bash archived · restore: context_recall(ctx://item/123)]`
   - extract / summary → trailing `raw: context_recall(ctx://item/123)`
2. **Three dead tool schemas taxed every request.** The search/pin/unpin
   model tools (0 invocations ever, pin state used 0 times) are removed
   from the model tool surface; `/context search|pin|unpin` user commands
   are unchanged. `context_recall` stays as the single model tool, with a
   promptSnippet that names the stub pattern explicitly.

The compact-fallback behavior users actually feel (native compaction at
the critical threshold) is unchanged. `/context stats` continues to
report cumulative saved tokens.

New test: every downgraded representation must carry a
`context_recall(ctx://item/…)` recovery hint (planContext end-to-end).

## 0.1.7 - 2026-08-27

- Footer cell minimized to `◎QoS 6%` — icon + pressure percentage with the level conveyed by color only. Drops the level word (`(绿)`), the token breakdown (活/省/库), and switches the icon from ⚡ (which collided with the quota prefix) to ◎. `/context stats` keeps the full report. Frozen renders as `◎QoS 6%·冻结`.

## 0.1.6 - 2026-08-27

- `/context` with no arguments now opens an interactive picker: every subcommand listed with a one-line Chinese explanation, so nothing has to be memorized. Picking an argument-taking subcommand (inspect / recall / search / pin / unpin) shows its usage and where to get a `ctx://item/<id>` reference instead of running it with an empty value. On runtimes without `ui.select` the picker degrades to a full usage table. Direct `/context <sub> [args]` invocation is unchanged.

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
