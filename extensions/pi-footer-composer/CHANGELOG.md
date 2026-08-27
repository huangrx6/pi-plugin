# Changelog

## 0.3.1 - 2026-08-27

- Back to five rows by request: subscription quotas merge into the 模型 row (`│`-separated) and context-governance statuses merge into the 资源 row, so the footer regains its compact single-column form while keeping the generic quota:/context: routing. 集成 now precedes 配置.

## 0.3.0 - 2026-08-27

- Seven-row layout: subscription quotas move to their own `用量：` row, context-governance statuses get a `压缩：` row, `配置：` now precedes `集成：`, and the resources row returns to pure token/cache/cost/occupancy cells. New routing: `quota:*` (and the unprefixed `quota` key) → 用量, `context:*` (and `context`/`qos` keywords) → 压缩, `usage:*` stays resources. Semantics improve: the subscription percentage and the two context percentages (raw occupancy vs effective-budget pressure) are no longer crammed into one row.

## 0.2.1 - 2026-08-27

- Support multi-line status cells: a status whose text contains `\n` now renders one sub-line per display row (indented under the row label) instead of being flattened to a single line. `sanitize` keeps intentional newlines while still normalizing every other kind of whitespace and dropping empty lines. Publishers opt into stacked output by simply including `\n` — the renderer stays content-agnostic.

## 0.2.0 - 2026-08-27

- Five labelled rows (环境 / 模型 / 资源 / 集成 / 配置) with `usage:` / `integration:` / `config:` key-prefix routing and a misc fallback.
