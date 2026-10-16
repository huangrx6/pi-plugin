# Changelog

## 0.4.3 - 2026-10-16

- 额度元素标签改为英文：`week:`、`month:`、`balance:`、`plan:`、`available:`、`status:`、`key:`、`key left:`、`account left:`，与底栏其余单元格的全英文标签一致。

## 0.4.2 - 2026-10-16

- 额度元素标签的冒号回到半角 `:`（`5h: 3%`、`周: 7%`）：全角冒号在等宽终端里占两列并留下空档，与状态栏其他单元格的紧凑写法不一致。

## 0.4.1 - 2026-10-16

- 额度元素标签的冒号统一为全角 `：`（`5h：`、`周：`、`月：`、`余额：` 等），与底栏其他单元格的 `描述：值` 写法一致。

## 0.4.0 - 2026-10-13

- 首次查询在飞时发布带盲文动画帧的「查询中…」占位，替代原来几秒的空白状态格；帧集合与 80ms 节奏对齐宿主 spinner（U+2800–28FF），只为已经显示宿主 spinner 的终端增加新东西。
- 动画重绘只在“无数据可显示”的 TUI 查询期间存在：RPC / json / print 只发一帧静态占位；成功、失败、会话关闭都会停止定时器（`unref()`，不阻止进程退出）；已有数据时的刷新仍直接显示旧值，不闪占位。

## 0.3.0 - 2026-09-10

- 状态发布 key 改为扩展自有名称 `pi-quota-status`，不再编码外部布局类别。
- 删除历史双写与前缀路由说明，保持单一发布源。

## 0.2.1

- Make `/quota` a concise daily view with readable usage meters, current values, refresh time, and state-specific errors. Move endpoints, credential names, adapter scope, and verification caveats into a secondary “数据来源与诊断” view and `/quota sources`.
- Use the native Pi selector and terminal theme for interaction instead of fixed ANSI colors. Keep the status contribution optional, plain, and capped to a compact width.
- Separate TUI dialogs from RPC, JSON, and print output. Sanitize terminal controls and bidi markers before rendering, and truncate by grapheme-aware display width for Chinese and emoji.

## 0.2.0 - 2026-09-04

- Add an independent `/quota` detail panel with refresh, source, credential variable, timestamps, and explicit failure states; native status remains an optional summary.
- Add domestic Kimi API / Moonshot and SiliconFlow balances with response validation and offline fixtures. Account dashboard reconciliation remains pending.
- Add `/quota account` for OpenRouter account credits using only `OPENROUTER_MANAGEMENT_KEY`; preserve ordinary API Key allowance as a separate metric and cache.
- Invalidate and cancel every old request before provider/key early returns and session cleanup. Cache identity includes provider, endpoint, and credential digest; recheck credentials before publishing. Mark retained values stale immediately on transient failures.
- Preserve DeepSeek balances when the account cannot call the API, including negative balances and multiple currencies. Show unknown money as `--`, reject malformed numeric strings, and avoid inventing reset times.
- Separate `moonshot` API billing from Kimi Code, require explicit Go provider mapping, guard regional/proxy mismatches, and stop labeling unverified Kimi overall windows as weekly.
- Add adapter fixtures and lifecycle regressions, including standalone command refresh and cleanup during an active request. Existing formatting tests remain intact.

## 0.1.0 - 2026-09-04

### Local dev parity: check/test scripts + first unit tests

The repo convention (AGENTS.md — every extension ships `npm run check` +
`npm test`) finally applies here too. CI already type-checked this
package via `npx -p typescript tsc`; now the same gates run locally:

- `npm run check` — `tsc -p . --noEmit` (typescript + @types/node +
  tsx added as devDependencies; lockfile committed).
- `npm test` — `tsx --test tests/*.test.ts`.
- `tests/format.test.ts` (7 cases) — oracle for the pure formatting
  layer: `formatDuration` (minute granularity, negative→"reset",
  NaN→""), `colorForPercent` (consumed share: green <50 / yellow 50–79
  / red ≥80), `formatBar` percentage/balance/text branches (null
  percent → dim `--%`, never a misleading `0%`), and `buildQuotaText`
  empty-cache → null.
- `files` whitelist fixed: the npm tarball previously shipped only
  `index.ts`, silently dropping `adapters.ts` / `format.ts` /
  `state.ts` / `constants.ts` / `types.ts` / `globals.d.ts`.
