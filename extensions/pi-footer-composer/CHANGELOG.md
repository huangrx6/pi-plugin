# Changelog

## 0.2.1 - 2026-08-27

- Support multi-line status cells: a status whose text contains `\n` now renders one sub-line per display row (indented under the row label) instead of being flattened to a single line. `sanitize` keeps intentional newlines while still normalizing every other kind of whitespace and dropping empty lines. Publishers opt into stacked output by simply including `\n` — the renderer stays content-agnostic.

## 0.2.0 - 2026-08-27

- Five labelled rows (环境 / 模型 / 资源 / 集成 / 配置) with `usage:` / `integration:` / `config:` key-prefix routing and a misc fallback.
