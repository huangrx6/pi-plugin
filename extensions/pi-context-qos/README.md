<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/context-qos.svg" alt="pi-context-qos" width="48" />
</p>

# pi-context-qos

<p align="center"><strong>Non-destructive, task-aware, recoverable working-context runtime.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.15-4c1?style=flat-square" />
</p>

Pi's append-only session stays authoritative. This extension archives tool evidence into a SQLite/FTS5 metadata index + content-addressed zstd cold store, then uses the `context` hook to choose `RAW → EXTRACT → SUMMARY → TOMBSTONE` representations for old tool-result blocks. The newest causal frontier, user messages, pins, unresolved failures, and the current file snapshots are hard-protected; only the deep-copied tool-result text is rewritten, never user / assistant / tool-call shape.

When QoS still cannot fit the budget, Pi's built-in compaction is called as a fallback — with explicit instructions to preserve the active objective, unresolved evidence, and `ctx://` recall references.

## Core guarantees

- **Non-destructive** — the Pi session JSONL is never written or rewritten
- **Hard-protected** — pinned items, unresolved failures, latest file snapshots, the active causal frontier, and user messages are never auto-downgraded
- **No orphan tool results** — tool calls and their results always stay paired; the planner only replaces tool-result text representations
- **Branch lineage** — every item carries `origin_entry_id`; `/tree` filters to the current branch; `/fork` inherits only the new branch's visible metadata
- **Monotonic representation** — automatic changes only ever move toward more compact forms; a frozen historical prefix is never re-expanded
- **Content-addressed** — raw text is SHA-256 hashed, zstd-compressed, and deduplicated across sessions
- **Database stays small** — SQLite holds metadata + deterministic summaries + FTS5 search index; large content lives in blobs
- **Tight permissions** — storage root `0700`, SQLite + blobs `0600`; secrets are redacted by default; excluded paths archive no body or search row
- **Last-resort native compaction** — only when critical-level degradation still leaves pressure at or above the critical threshold

## How it works

```text
tool_result
  → normalize text
  → SHA-256 original
  → security decision / redact
  → deterministic tool compressor
  → zstd CAS archive
  → SQLite metadata + FTS5

context
  → refresh active branch lineage
  → estimate effective pressure
  → protect user / frontier / pin / unresolved / latest-file
  → compute explainable retention score
  → choose monotonic representation
  → replace only the deep-copied tool-result text
  → return messages to Pi
  → native compact only when still over budget
```

## Data model

- `sessions` — Pi session path, project root, model, window, turn, freeze, current epoch
- `tasks` — current user objective (internal lightweight task model; does not read external todo systems)
- `epochs` — closed every N turns; frozen summaries never auto-rewritten
- `context_items` — tool call, branch origin, file, hash, tokens, tier, representation, score, pin / unresolved / superseded / duplicate, structured summary
- `blobs` — CAS hash, compressed size, access time; physical content in `blobs/<prefix>/<hash-rest>.zst`
- `context_fts` — FTS5 index over metadata / summaries only; never the redacted original

## Tier vs representation

- **Tier** describes purpose: `PINNED / WORKING / EVIDENCE / HISTORICAL / DISPOSABLE`
- **Representation** describes the form sent to the model: `RAW / EXTRACT / SUMMARY / TOMBSTONE`

The two are independent. Automatic representation changes are monotonic; `context_recall` re-injects raw content as a new tool result on the active frontier, never by rewriting the frozen prefix.

## Causal safety

The planner never deletes assistant / user / tool-result messages — it only replaces the text representation of old tool results, so the original assistant tool call and tool result still pair up.

The active frontier is computed from BOTH recent user turns AND recent causal blocks. Whichever boundary is earlier stays intact; everything after it is rewritten.

## Branch and fork

Every item stores the `origin_entry_id` from the tool call's branch entry. After `/tree`, only the current `getBranch()`-visible origins load. `/fork` creates a new session and inherits metadata via `previousSessionFile` (only the new branch's visible metadata is copied; blob hashes are shared, but item IDs and `ctx://` refs are regenerated in the new session so visibility cannot leak across sessions).

## Security

1. Storage root and blob shards are `0700`
2. SQLite and blob files are `0600`
3. Common tokens / passwords / private keys / DSNs are recognised and redacted before they hit disk
4. Excluded paths only save hash + "not archived" stub; body and search index never contain them
5. Project config (`<repo>/.pi/context-qos.json`) is loaded only when `ctx.isProjectTrusted()` is true
6. GC only touches QoS-derived data; Pi Session is never affected

## Pressure strategy

Pressure is computed against **effective budget** (`contextWindow − outputReserve − safetyReserve`), not raw window.

| Zone | Threshold | Default action |
| --- | --- | --- |
| Green | < 55% | Deduplicate; covered content forms stable summaries |
| Yellow | 55–70% | `disposable` / `superseded` → `extract` |
| Orange | 70–82% | `historical` and low-relevance evidence → `extract` |
| Red | 82–92% | Low-scoring content → `summary` / `tombstone` |
| Critical | ≥ critical | Maximise degradation; if post-plan pressure is still at or above the critical threshold, fall back to Pi's native compaction |

Score is an explainable linear combination: task relevance, importance, unresolved, causal dependency, recency, uniqueness, code proximity, verification value. Pinned, unresolved failures, latest-file snapshots, and the active frontier are hard rules that always outrank the score.

Re-tuning thresholds and reserves: write `~/.pi/agent/context-qos/config.json` (or `<repo>/.pi/context-qos.json` when trusted). The default layout:

```json
{
  "enabled": true,
  "budget": {
    "outputReserveRatio": 0.12,
    "safetyReserveRatio": 0.06,
    "yellow": 0.55,
    "orange": 0.7,
    "red": 0.82,
    "critical": 0.92,
    "nativeCompactFallback": true
  },
  "frontier": {
    "protectedUserTurns": 2,
    "protectedCausalBlocks": 8
  },
  "storage": {
    "directory": "~/.pi/agent/context-qos",
    "maxBytes": 2147483648,
    "maxAgeDays": 30
  },
  "epochs": {
    "maxTurns": 12
  },
  "security": {
    "archiveSecrets": false,
    "excludePatterns": ["**/.env", "**/*.pem", "**/secrets/**"]
  }
}
```

Thresholds must be strictly increasing within `(0, 1)`; `outputReserveRatio + safetyReserveRatio < 0.8`.

## Default storage layout

```text
~/.pi/agent/context-qos/
├── context.db
├── context.db-wal
├── context.db-shm
├── blobs/
│   └── ab/
│       └── <sha256-rest>.zst
└── config.json
```

Project repositories may only carry a policy file `<repo>/.pi/context-qos.json`. No real context data is written into the project.

## Deterministic compression

First-version compressors: tests, git, file reads, search and generic Bash. Structured summaries preserve facts, decisions, errors, files, symbols, unresolved, and next actions. No source code or terminal output is sent to any external summary model.

## Model tools

| Tool | Purpose |
| --- | --- |
| `context_recall({ ref })` | Restore `ctx://item/<id>` to the current working context. If the raw body was not archived or has been GC'd, returns a traceable summary instead. |
| `context_search({ query, limit? })` | FTS5 search across the current session branch's metadata and summaries. |
| `context_pin({ ref })` | Pin an item; subsequent auto-degradation skips it. |
| `context_unpin({ ref })` | Unpin. |

## User commands

Running `/context` with **no arguments** opens an interactive picker: each subcommand listed with a one-line Chinese explanation. Argument-taking subcommands show their usage when picked. Direct invocation is unchanged:

```text
/context                  status overview
/context stats            detailed pressure stats
/context top              top-relevance items
/context tree             tier-grouped item tree
/context tasks            internal task list
/context epochs           epoch summary
/context inspect <ref>    single item details
/context recall <ref>     recall raw content
/context search <query>   FTS search
/context pin <ref>        pin
/context unpin <ref>      unpin
/context gc [--aggressive]  run GC
/context freeze           freeze transformations (audit mode)
/context unfreeze
/context doctor           diagnostic dump
/context config           print resolved config
/context reset-session    reset this session's QoS metadata only
```

`/context reset-session` only clears the **current session's** QoS metadata; the Pi Session JSONL is untouched and shared blobs are not directly deleted — unreferenced blobs are cleaned up by GC.

## Footer status

The status is published at `session_start` (before any model call, so it is visible from the first paint) and refreshed after every model call, under the `context:qos` key via Pi's status API. It renders as one compact line in the quota-status idiom, in the context-governance row of a multi-row footer:

```text
用量： ⚡GLM 5h:40%(3h11m) 周:32%(83h24m)
资源： ↑2.2M │ ↓122k │ R21M │ CH10.5% │ $5.808 │ 21.1%/1.0M
压缩： ⚡QoS 22%(绿) 活179k 省22.9k 库165项
```

| 字段 | 含义 |
| --- | --- |
| `⚡QoS 22%(绿)` | 有效预算（contextWindow × 0.82）占用百分比与压力级别（绿/黄/橙/红/危），整段按级别着色，危级加粗；冻结时显示 `(绿·冻结)` |
| `活179k` | 进入 LLM 上下文的估算 tokens（含 system prompt 等固定开销）；尾零省略（179.0k → 179k） |
| `省22.9k` | QoS 降级累计省下的 tokens（原始量 − 当前活跃量） |
| `库165项` | 冷库中归档的上下文条目数（可 `context_recall` 的池子） |

## Install

Requires Node.js `>=22.15` (uses `node:sqlite`, FTS5, and zstd, all built-in).

```bash
pi install git:github.com/huangrx6/pi-context-qos
```

Or via the monorepo. Restart Pi or `/reload`.

## Requirements

- Node.js `>=22.15`
- Pi Coding Agent (any version supporting the documented extension contract)
- No external services; the cold store and FTS index live entirely under `~/.pi/agent/context-qos/`

## Invariants covered by tests

- `context` input deep copy is never mutated in place
- User messages preserved
- Active frontier stays raw
- Branches do not cross-contaminate item visibility
- zstd CAS deduplicates and round-trips losslessly
- Secrets redacted; excluded paths do not archive
- Test failures stay unresolved until a matching test command runs successfully
- New file versions supersede old ones; same version deduplicates
- FTS5 searches only derived metadata / summaries
- Extension lifecycle, tools, commands, and checkpoint all run through smoke

## Pi API contract

Implementation targets Pi `0.84.x`'s extension contract: `context`, `tool_result`, `session_start`, `session_tree`, `session_compact`, `getContextUsage()`, `ctx.compact()`, and `pi.appendEntry()`. Runtime only rewrites the deep copy of `context`'s messages.

## Development

```bash
cd extensions/pi-context-qos
npm install
npm run check      # type-check twice: ambient shim + real pi types
npm test           # 12 unit tests + 1 lifecycle smoke
```

`check` runs the ambient-shim typecheck first, then a second pass against the real installed Pi types (via `tsconfig.runtime.json`, which excludes the shim and tests). Test fixtures all live under `os.tmpdir()`.

## File structure

```text
pi-context-qos/
├── index.ts                    # extension assembly + lifecycle wiring
├── globals.d.ts                # ambient shim for local type-check
├── tsconfig.json               # includes shim
├── tsconfig.runtime.json       # excludes shim (real types)
├── src/
│   ├── types.ts                # domain types (tier / representation / pressure / structured summary)
│   ├── config.ts               # defaults + global / project merge + validation
│   ├── compressors/            # tests / git / read / grep / bash / common / index
│   ├── runtime/                # controller / context / planner / scorer / pressure / archive / tokens
│   ├── security/redaction.ts   # 4 secret patterns + path exclusion
│   └── storage/                # database / blob-store / gc
└── tests/                      # core.test.ts + extension.test.ts
```

## License

MIT © huangrx6
