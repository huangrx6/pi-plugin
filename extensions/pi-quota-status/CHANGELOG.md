# Changelog

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
