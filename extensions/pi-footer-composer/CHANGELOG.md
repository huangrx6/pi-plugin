# Changelog

## 0.7.0 - 2026-09-05

- Group related fields into seven fixed category rows instead of filling individual boxes across columns.
- Remove left and right outer borders; keep horizontal rules and one aligned category divider.
- Wrap fields within their category, keeping short fields intact and showing each category label once. Preserve muted text and dim separators.

## 0.6.0 - 2026-09-05

- Replace the full view's loose rows with a bordered table: one field per cell, shared column widths, aligned intersections and padded final rows.
- Adapt from one to four columns as terminal width increases; wrap long paths and statuses inside cells using grapheme display widths.
- Use muted gray for all full-view text and dim borders, removing differences in brightness and font weight. Preserve status wording and values.
- Cover responsive borders, multiline content, terminal-control sanitization and full/compact/native switching.

## 0.5.1 - 2026-09-05

- Unify normal content color and font weight; use whitespace between fields and readable muted labels.
- Separate model identity, quota, current context and accumulated usage into short rows; keep full view as the default and hide empty groups.
- Remove leading decorative status icons and omit only redundant pure context percentages matching host usage. Preserve warnings and descriptive statuses.

## 0.5.0 - 2026-09-05

- Default to full view on load; keep compact and native views available in the single-level selector.
- Use quiet labels, soft dot separators, an accent model name and readable cache/context labels. Keep wrapped content aligned and empty groups hidden.
- Include published `usage:` statuses in full view and put current context occupancy before accumulated usage.
- Fix unlabelled rows exceeding their width by an extra leading space; cover full/compact/native switching and narrow widths.

## 0.4.0 - 2026-09-04

- Default to a three-row compact view: environment, model with quota, then context and configuration status. Full resource and integration detail remains available with `/footer full`.
- Add `/footer compact|full|native`; native mode immediately restores Pi's built-in footer, and cancelling the selector stays silent.
- Strip CSI, OSC, DCS and control bytes from paths, model metadata and published statuses before applying the current terminal theme.
- Keep labels within the available width on extremely narrow terminals, including emoji presentation sequences in display-width measurement.
- Add interaction coverage for compact/full/native switching and terminal-control sanitization; publish from an explicit package file allowlist.

## 0.3.2 - 2026-09-04

### Fix: `truncateToWidth` infinite loop on ANSI-colored wide cells

The inner escape-scan regex was built without the `g` flag, so `exec`
kept returning the FIRST escape forever. Any theme-colored cell wider
than its row budget — the footer's normal case: usage stats, context
percentage, extension statuses (e.g. quota bars) are all colored —
looped forever and froze the renderer on narrow terminals. One-flag
fix (`new RegExp(ANSI_PATTERN.source, "g")`) plus a regression test
that previously hung indefinitely.

### Local dev parity

- `npm run check` (`tsc --noEmit`) and `npm test` (`tsx --test
  tests/*.test.ts`) scripts added, with typescript/tsx/@types/node
  devDependencies and a committed lockfile — same gates CI already
  runs via `npx`.
- `tests/layout.test.ts` (9 cases): visibleWidth (ASCII / ANSI /
  CJK), truncateToWidth (short / exact / over-wide ASCII / CJK grapheme
  boundary / ANSI-preserving), makeCell.

## 0.3.1 - 2026-08-27

- Back to five rows by request: subscription quotas merge into the 模型 row (`│`-separated) and context-governance statuses merge into the 资源 row, so the footer regains its compact single-column form while keeping the generic quota:/context: routing. 集成 now precedes 配置.

## 0.3.0 - 2026-08-27

- Seven-row layout: subscription quotas move to their own `用量：` row, context-governance statuses get a `压缩：` row, `配置：` now precedes `集成：`, and the resources row returns to pure token/cache/cost/occupancy cells. New routing: `quota:*` (and the unprefixed `quota` key) → 用量, `context:*` (and `context`/`qos` keywords) → 压缩, `usage:*` stays resources. Semantics improve: the subscription percentage and the two context percentages (raw occupancy vs effective-budget pressure) are no longer crammed into one row.

## 0.2.1 - 2026-08-27

- Support multi-line status cells: a status whose text contains `\n` now renders one sub-line per display row (indented under the row label) instead of being flattened to a single line. `sanitize` keeps intentional newlines while still normalizing every other kind of whitespace and dropping empty lines. Publishers opt into stacked output by simply including `\n` — the renderer stays content-agnostic.

## 0.2.0 - 2026-08-27

- Five labelled rows (环境 / 模型 / 资源 / 集成 / 配置) with `usage:` / `integration:` / `config:` key-prefix routing and a misc fallback.
