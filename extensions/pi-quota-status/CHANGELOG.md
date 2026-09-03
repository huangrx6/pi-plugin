# Changelog

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
