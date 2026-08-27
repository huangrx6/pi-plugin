<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/footer-composer.svg" alt="footer-composer" width="48" />
</p>

# pi-footer-composer

<p align="center"><strong>Five labelled rows: environment, model, resources, integrations, configuration.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

Takes over Pi's footer rendering and produces five single-column rows, each prefixed with a dim two-character label. Every other status that any extension publishes via `ctx.ui.setStatus(...)` is collected and routed into the right row by key prefix.

This is a renderer only. It does not own any data; it only consumes `ctx.sessionManager` and the public `setStatus` API. If the extension is uninstalled, the original Pi footer returns.

## Output

Five fixed rows in order — environment → model → resources → integrations → configuration. Each row has a dim leading label and a leading first cell; multi-cell rows use `│` to separate cells within the row, and the row wraps (instead of merging rows) when the terminal is too narrow. A status cell whose text contains `\n` is a **multi-line cell**: each sub-line renders on its own display row (indented under the label) and is never packed alongside other cells — publishers opt into stacked output simply by including a newline.

Wide terminal:

```text
环境： ~/project (main) • 优化
模型： (zai-coding-cn) glm-5.2
资源： ↑1.2k ↓890 R340 CH45% $0.012  12%/128k  ⚡GLM 5h:4%
集成： 🔌 MCP: 3 servers enabled │ LSP Inactive
配置： ◈ mode:帮我批准 │ policy:standard/executing
```

Narrow terminal — wrapped cells indent to the label width, rows stay distinct; multi-line status cells keep one sub-line per display row:

```text
环境： ~/project
       (main)
       • 优化
模型： (zai-coding-cn) glm-5.2
资源： ↑1.2k ↓890 R340 CH45%
       12%/128k
       ⚡GLM 5h:4%(4h50m)
集成： 🔌 MCP: 3 servers
       │ LSP Inactive
配置： ◈ mode:帮我批准
       │ policy:standard
```

## Row contents

| Row | Label | Source | Examples |
| --- | --- | --- | --- |
| 1 | `环境：` | `ctx.sessionManager` (cwd, session name) + `footerData.getGitBranch()` + session title | `~/project (main) • 优化` |
| 2 | `模型：` | `ctx.model` (provider, id) + thinking level | `(zai-coding-cn) glm-5.2` |
| 3 | `资源：` | `ctx.sessionManager` (usage stats) + `ctx.getContextUsage()` + `usage:*` statuses | `↑1.2k ↓890 R340 CH45% $0.012  12%/128k  ⚡GLM 5h:4%` |
| 4 | `集成：` | `integration:*` statuses (MCP, LSP) | `🔌 MCP: 3 servers enabled │ LSP Inactive` |
| 5 | `配置：` | `config:*` statuses (mode, policy) + unclassified statuses as misc fallback | `◈ mode:帮我批准 │ policy:standard/executing` |

Label-to-first-cell separator is a single space (no `│`); wrapped continuations from subsequent cells indent to the label width.

## Status → row routing (key-prefix convention)

Extensions choose which row their status lands in by the key they pass to `ctx.ui.setStatus(...)`. Recommended prefixes:

| Key shape | Lands in |
| --- | --- |
| `usage:<name>` | row 3 (resources) |
| `integration:<name>` | row 4 (integrations) |
| `config:<name>` | row 5 (configuration) |
| anything else | row 5 (misc fallback — never silently dropped) |

For keys without a recognised prefix, a generic-keyword fallback still routes sensibly:

| Unprefixed key contains | Routed to |
| --- | --- |
| `mcp` or `lsp` | row 4 (integrations) |
| `mode` or `policy` | row 5 (configuration) |
| `quota` | row 3 (resources) |

ANSI colors from upstream statuses (e.g. quota colour thresholds) are preserved verbatim.

## Data sources (composition, not coupling)

This extension **does not know any other extension by name**. It only consumes the public aggregation surface that Pi exposes:

| Content | Source |
| --- | --- |
| cwd / session name / usage stats | `ctx.sessionManager` (entries' usage rollup) |
| context usage | `ctx.getContextUsage()` |
| git branch / available providers | `footerData.getGitBranch()` / `getAvailableProviderCount()` |
| extension statuses | `footerData.getExtensionStatuses()` — i.e. whatever every extension has published via `ctx.ui.setStatus()`, routed purely by key prefix |

Any extension that calls `setStatus` automatically appears in the table; this extension does not need to know — and does not whitelist — who they are.

## Differences from Pi's native footer

Pi's native footer shows a few internal markers (`(sub)` subscription flag, `xp` experimental indicator, auto-compact toggle) that extensions cannot read. This extension renders **only what extensions can see**, so those markers are absent. If you need them, uninstall this extension and the native footer returns (Pi's `setFooter(undefined)` semantics).

## Install

```bash
pi install git:github.com/huangrx6/pi-footer-composer
```

Or via the monorepo. Restart Pi or `/reload`.

## Known limitations

- **Footer exclusive**: `setFooter` is a replacement. Installing any other extension that calls `setFooter` will clash and the two renderers will overwrite each other. This extension's existence IS the "single footer renderer" convention — install it alone.
- Usage stats refresh on `turn_end`; branch changes refresh immediately via `onBranchChange`.

## File structure

```text
pi-footer-composer/
├── index.ts          # event wiring + status collection + render
├── layout.ts         # width helpers + renderTable (greedy wrap, multi-line cells)
├── globals.d.ts      # ambient shim for the Pi runtime types
├── tsconfig.json     # local type-check
├── package.json
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## License

MIT © huangrx6
