<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/quota-status.svg" alt="quota-status" width="48" />
</p>

# pi-quota-status

<p align="center"><strong>Per-model subscription usage in the Pi status row.</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

Publishes the current AI subscription's remaining usage to Pi's status row via `ctx.ui.setStatus("quota", …)`, automatically switching data sources when you switch models.

This extension is a **publisher only**. It does not own the footer; rendering position and styling are decided by Pi's footer layer (native footer or whatever footer-renderer extension you have installed).

## Display

```text
> in: pi-plugin  ~/project (main) • fix retry binding  ↑1.2k ↓890 R340  $0.012 12%/128k
… ⚡GLM 5h:0%(2h28m) 周:0%(70h21m)
```

When you switch models, the displayed provider switches automatically:

| Active model | Status text |
| --- | --- |
| `opencode-go/deepseek-v4-pro` | `⚡OC 5h:1%(2h5m) 周:7%(66h45m) 月:3%(646h27m)` |
| `zai-coding-cn/glm-5.2` | `⚡GLM 5h:0%(2h28m) 周:0%(70h21m)` |
| `minimax/MiniMax-M2.7` (also `cc-switch-mini-max/...`) | `⚡MiniMax 5h:5%(4h53m) 周:42%(3d22h)` |
| `kimi/MiniMax-M2.7`, `moonshot/...`, `kimi-code/...` | `⚡Kimi 5h:0%(2h10m) 周:38%(4d12h)` |
| `deepseek/deepseek-chat`, `deepseek-cn/...` | `⚡DeepSeek 余额:¥42.30` |
| `openrouter/anthropic/claude-3.5-sonnet` | `⚡OR 额度:$8.50` |
| Anything else | (nothing — no recognized subscription) |

## Supported subscriptions

| Provider prefix | Subscription | Shape | Endpoint | API key env var |
| --- | --- | --- | --- | --- |
| `opencode-go/...` | OpenCode Go | 5h / weekly / monthly % | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_API_KEY` |
| `zai-coding-cn/...` | Zhipu GLM Coding Plan | 5h / weekly % | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `ZAI_CODING_CN_API_KEY` (alias `ZAI_API_KEY`) |
| `minimax`, `cc-switch-mini-max`, ... | MiniMax Token Plan | 5h / weekly % | `GET https://www.minimaxi.com/v1/token_plan/remains` | `MINIMAX_CN_API_KEY` (alias `MINIMAX_API_KEY`) |
| `kimi`, `moonshot`, `kimi-code` | Kimi Code membership | 5h / weekly % | `GET https://api.kimi.com/coding/v1/usages` | `KIMI_API_KEY` |
| `deepseek`, `deepseek-cn` | DeepSeek pay-as-you-go | balance (CNY) | `GET https://api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | remaining credit (USD) | `GET https://api.openrouter.ai/api/v1/key` | `OPENROUTER_API_KEY` |

The Kimi Code key (`sk-kimi-...`) is **different** from the Moonshot Open Platform key (`sk-...`); do not mix them up.

## Field meanings

| Field | Meaning | Source |
| --- | --- | --- |
| `5h:` | Used percent in the 5-hour rolling window | OpenCode `usage.rolling`; Zhipu `TOKENS_LIMIT unit=3`; MiniMax `general.current_interval_remaining_percent` (`100 − remaining`); Kimi `limits[duration=300].detail` |
| `周:` | Used percent in the weekly window | OpenCode `usage.weekly`; Zhipu `unit=6`; MiniMax `general.current_weekly_remaining_percent`; Kimi `usage` (typically weekly) |
| `月:` | Used percent in the monthly window | OpenCode `usage.monthly` (only OpenCode shows it) |
| `余额:¥42.30` | DeepSeek available balance (CNY) | `balance[0].total_balance`, only when `is_available` is true |
| `额度:$8.50` | OpenRouter remaining credit (USD) | `data.limit_remaining` (shows `免费额度:` for free tier) |
| `(2h5m)` | Countdown to the window reset | `resetsAt` / `nextResetTime` / `end_time` minus now; MiniMax falls back to `remains_time` |
| `OC` / `GLM` / `MiniMax` / `Kimi` / `DeepSeek` / `OR` | Subscription tag | provider name → display |

## Colors

For percentage windows:

| Used | Color | Meaning |
| --- | --- | --- |
| < 50% | green (`\x1b[32m`) | safe |
| 50–79% | yellow (`\x1b[33m`) | caution |
| ≥ 80% | red (`\x1b[31m`) | urgent |

Balance / credit lines render in **dim** (`\x1b[2m`): low balance is not necessarily an error, so color-coding it would mislead. Countdowns and separators also use dim.

## Empty / error rendering

| Scenario | Display |
| --- | --- |
| Percent is `null` | `5h:--%` (dim placeholder) — never shown as `undefined%` or `0%` |
| Reset time missing / invalid | the `(2h28m)` suffix is omitted |
| Request timeout (15s) | `⚠ ⚡OC 请求超时` |
| Network failure | `⚠ ⚡OC 网络不可达` (normalizes `fetch failed` / `ENOTFOUND`) |
| HTTP 401/403 | `⚠ ⚡OC Key 无效或已过期 (HTTP 401)` |
| HTTP 429 | `⚠ ⚡OC 请求过于频繁 (HTTP 429)` |
| HTTP 5xx | `⚠ ⚡OC 服务暂不可用 (HTTP 502)` |

On a transient error from the same provider, the previous successful value is kept for 60 s (`STALE_KEEP_MS`) with a trailing `?` to mark it as possibly stale. On a provider switch, the stale value is dropped immediately.

## Refresh triggers

No `setInterval`. Timers would capture the session ctx and become stale after `/reload` or session replacement, crashing Pi.

| Trigger | Delay | Throttle | Reason |
| --- | --- | --- | --- |
| Model switch (`model_select`) | immediate | none | Switching providers must refresh the data source instantly |
| `turn_end` | within ~10 s | 10 s | Reflects real usage; throttled against back-to-back turns |
| `session_tree` (branch change) | within ~5 s | 5 s | Refresh after revert / fork |
| `session_start` | immediate | none | Show current model usage at boot |
| `session_shutdown` | — | — | Clear cache so the next session does not show stale data |

## Install

```bash
pi install git:github.com/huangrx6/pi-quota-status
```

Or via the monorepo: `pi install git:github.com/huangrx6/pi-plugin`. Restart Pi or `/reload`.

## Configuration

The extension reads API keys from environment variables — never writes them to disk. The variable names match Pi's official convention, so the same env var is honored by both `auth.json` and this extension.

```bash
export OPENCODE_API_KEY="oc-..."
export ZAI_CODING_CN_API_KEY="..."        # ZAI_API_KEY also accepted
export MINIMAX_CN_API_KEY="ey..."           # MINIMAX_API_KEY also accepted
export KIMI_API_KEY="sk-kimi-..."
export DEEPSEEK_API_KEY="sk-..."
export OPENROUTER_API_KEY="sk-or-v1-..."
```

Not supported: **Xiaomi MiMo**. Its official quota endpoint requires login cookies (~1-day expiry); there is no public API-key-based query. Check MiMo usage manually in the console.

## Adding a new provider

Two edits, nothing else.

1. Add the endpoint to `ENDPOINTS`:

   ```typescript
   const ENDPOINTS = {
     // existing…
     yourname: "https://api.example.com/quota",
   } as const;
   ```

2. Add an adapter to `ADAPTERS`:

   ```typescript
   const ADAPTERS = {
     // existing…
     yourname: {
       display: "⚡YY",
       providerNames: ["your-provider-name"],
       apiKeyEnvVar: "YOUR_API_KEY",
       endpoint: ENDPOINTS.yourname,
       async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
         const json = await fetchJsonBearer<ResponseShape>(ENDPOINTS.yourname, apiKey);
         return [
           { kind: "percentage", label: "5h", percent: json.usage5h },
           // or:
           { kind: "balance", label: "余额", amount: json.amount, currency: "CNY" },
           // or:
           { kind: "text", label: "info", text: json.note },
         ];
       },
     },
   } as const satisfies Record<string, QuotaAdapter>;
   ```

The `Subscription` type is `keyof typeof ADAPTERS` — it follows the registry automatically. `PROVIDER_TO_SUB` and the rendering pipeline (`formatBar` + `refreshQuota`) pick up the new entry without further edits. Three return shapes are supported:

| `QuotaBar.kind` | Use for |
| --- | --- |
| `percentage` | rolling-window percentage (5h / weekly / monthly) |
| `balance` | remaining monetary balance / credit |
| `text` | any free-form escape hatch |

## Data model: `QuotaBar` discriminated union

Adapters return `QuotaBar[]` only — no provider label (the framework attaches `display` from the adapter). `formatBar` switches on `kind` with a `never` guard so a new `kind` added without a case fails to compile.

## Robustness

- **No `setInterval`** — avoids stale-ctx crashes after `/reload` / session replacement
- **Fetch sequence guard** — fast model switches can produce out-of-order responses; `++fetchSeq` plus `seq !== fetchSeq` lets stale responses drop on the floor
- **Stale-keep** — on transient failure, the previous value is held for 60 s with a `?` suffix; only persistent failure clears it
- **`session_shutdown` cleanup** — new sessions never inherit old-session data
- **Global regex `lastIndex` safety** — `ANSI_ONCE` (non-global) avoids `exec()` state pollution
- **Grapheme-aware width** — `Intl.Segmenter` for correct CJK / emoji truncation
- **Adapter exhaustiveness** — `as const satisfies` + `never` guard catches missing fields at compile time

## File structure

```text
pi-quota-status/
├── index.ts          # event wiring + refresh logic + status publishing
├── types.ts          # all types (no runtime code)
├── constants.ts      # timeouts / ANSI codes / status key
├── state.ts          # module-level mutable state
├── adapters.ts       # ADAPTERS registry + key resolution
├── format.ts         # formatBar / buildQuotaText
├── globals.d.ts      # ambient shim for the Pi runtime types
├── tsconfig.json     # local type-check
├── package.json
├── README.md
└── LICENSE
```

## License

MIT © huangrx6
