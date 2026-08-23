# pi-quota-status

在 pi 的 **footer（底部状态栏）** 显示当前 AI 订阅的剩余用量，并根据当前选择模型**自动切换**数据源。扩展还完整接管了 footer 渲染——在保留 pi 原生信息（cwd、git 分支、会话名、token 统计、上下文占用、成本、模型名）同时，把用量靠右显示在状态行。

## 效果

```
┌─────────────────────────────────────────────────────────────┐
│  (聊天消息区域)                                              │
├─────────────────────────────────────────────────────────────┤
│  > 在这里输入...                                             │  ← 编辑器
├─────────────────────────────────────────────────────────────┤
│  ~/project (main) • feat/x  ↑1.2k ↓890 R340  $0.012 12%/128k │  ← footer 行1: 环境+统计
│  ⚡GLM 5h:0%(2h28m) 周:0%(70h21m)         (opencode-go) v4   │  ← footer 行2: 用量靠右 + 模型
└─────────────────────────────────────────────────────────────┘
```

- **行 1**：cwd、git 分支、会话名、输入/输出/缓存 token、缓存命中率、成本、上下文占用
- **行 2**：当前模型的用量（靠右对齐，颜色高亮）+ 左侧为扩展状态

切换模型时显示自动切换：

| 当前模型 | 用量显示 |
| --- | --- |
| `opencode-go/deepseek-v4-pro` | `⚡OC 5h:1%(2h5m) 周:7%(66h45m) 月:3%(646h27m)` |
| `zai-coding-cn/glm-5.2` | `⚡GLM 5h:0%(2h28m) 周:0%(70h21m)` |
| `minimax/MiniMax-M2.7`（或 `cc-switch-mini-max/MiniMax-M2.7`）| `⚡MiniMax 5h:5%(4h53m) 周:42%(3d22h)` |
| `kimi/MiniMax-M2.7` 或 `moonshot/...` 或 `kimi-code/...` | `⚡Kimi 5h:0%(2h10m) 周:38%(4d12h)` |
| `deepseek/deepseek-chat` 或 `deepseek-cn/...` | `⚡DeepSeek 余额:¥42.30` |
| `openrouter/anthropic/claude-3.5-sonnet` | `⚡OR 额度:$8.50` |
| `native/deepseek-v4-pro`（原生）| 不显示（未识别的订阅源）|

## 支持的订阅

| Provider（模型前缀） | 订阅 | 数据形状 | 查询接口 | 环境变量 |
| --- | --- | --- | --- | --- |
| `opencode-go/...` | OpenCode Go | 百分比窗口（5h/周/月）| `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_API_KEY` |
| `zai-coding-cn/...` | 智谱 GLM Coding Plan | 百分比窗口（5h/周）| `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `ZAI_API_KEY` |
| `minimax` / `cc-switch-mini-max` / ... | MiniMax Token Plan | 百分比窗口（5h/周）| `GET https://www.minimaxi.com/v1/token_plan/remains` | `MINIMAX_API_KEY` |
| `kimi` / `moonshot` / `kimi-code` | Kimi Code 会员 | 百分比窗口（5h/周）| `GET https://api.kimi.com/coding/v1/usages` | `KIMI_API_KEY` |
| `deepseek` / `deepseek-cn` | DeepSeek 按量付费 | 余额（`¥`/`$`）| `GET https://api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | 剩余信用（`$`）| `GET https://openrouter.ai/api/v1/key` | `OPENROUTER_API_KEY` |

> ⚠️ **Kimi Code 的 Key 与 Moonshot Open Platform 不同**：会员 API 用 `sk-kimi-...` 专属 key；普通 Moonshot 按量平台用 `sk-...`，那个走的是 `/v1/users/me/balance`（余额接口，本扩展不接）——不要混用。

## 字段含义

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `5h:` | 5 小时滚动窗口已用百分比 | OpenCode `usage.rolling`；智谱 `TOKENS_LIMIT unit=3`；MiniMax `general.current_interval_remaining_percent`（取 100 − remaining）；Kimi `limits[duration=300].detail` |
| `周:` | 每周窗口已用百分比 | OpenCode `usage.weekly`；智谱 `TOKENS_LIMIT unit=6`；MiniMax `general.current_weekly_remaining_percent`；Kimi `usage`（通常是周窗口）|
| `月:` | 每月窗口已用百分比 | OpenCode `usage.monthly`（智谱、MiniMax、Kimi 不显示）|
| `余额:¥42.30` | DeepSeek 可用余额（CNY）| `balance[0].total_balance`（仅当 `is_available` 为 true；否则显 0）|
| `额度:$8.50` | OpenRouter 剩余信用（USD）| `data.limit_remaining`（免费层显 `免费额度:`）|
| `(2h5m)` | 距该窗口重置的倒计时 | `resetsAt` / `nextResetTime` / `end_time` 减去当前时间；MiniMax 在仅有 `remains_time` 时退而用相对毫秒数 |
| `OC` / `GLM` / `MiniMax` / `Kimi` / `DeepSeek` / `OR` | 订阅来源标识 | opencode-go → OC；zai-coding-cn → GLM；minimax/*→ MiniMax；kimi/* → Kimi；deepseek/* → DeepSeek；openrouter → OR |
| `↑1.2k ↓890 R340 W50 CH45%` | 输入/输出/缓存读/缓存写 token + 缓存命中率 | 会话消息 usage |
| `$0.012` | 累计成本 | 会话消息 usage.cost |
| `12%/128k` | 上下文占用百分比 / 窗口大小 | `ctx.getContextUsage()` |

## 颜色高亮

**百分比窗口**按用量阈值着色：

| 用量 | 颜色 | 含义 |
| --- | --- | --- |
| < 50% | 绿色（`\x1b[32m`）| 安全 |
| 50–79% | 黄色（`\x1b[33m`）| 注意 |
| ≥ 80% | 红色（`\x1b[31m`）| 紧急 |

**余额/额度**用统一灰色（`\x1b[2m` dim）显示——低余额不代表异常（可能只是花得少），用绿/黄/红会误导；保留 dim 表示信息但不强调。

倒计时和分隔符也用 dim。

## 刷新策略

纯事件驱动（**无 setInterval**——定时器会捕获 session ctx，在 `/reload` 或 session 替换后变成 stale ctx 导致 pi 崩溃）：

| 触发时机 | 延迟 | 节流 | 原因 |
| --- | --- | --- | --- |
| **模型切换**（`model_select`）| 立即 | 无（强制）| 换 provider 必须立刻切换数据源 |
| **每轮对话结束**（`turn_end`）| ~10s 内 | 10s | 用量真实消耗后马上更新；节流防连续对话风暴 |
| **session_tree**（回退/分支）| ~5s 内 | 5s | 回退到历史点后刷新当前状态 |
| **session_start** | 立即 | 无 | 会话启动显示当前模型用量 |
| **session_shutdown** | — | — | 清空缓存，避免新会话显示旧数据 |

## 安装

### 在线安装

```bash
pi install git:github.com/huangrx6/pi-quota-status
```

### 离线安装

```bash
pi install /Users/huangrx6/pi-quota-status
```

### 手动放置

将 `index.ts`、`package.json` 放入 pi 扩展自动发现目录：

```
/Users/huangrx6/.pi/agent/extensions/pi-quota-status/
```

pi 启动时自动扫描加载。重启 pi 或 `/reload` 生效。

## 配置

扩展读取环境变量作为 API Key（**不写入任何文件**）。`apiKeyEnvVar` 对齐 pi-coding-agent 官方约定——你只需要在 shell 里设一次 env，pi 的 auth.json 和本扩展都会读到：

```bash
# OpenCode Go / OpenCode (同一个 Key 对应两个 pi provider 名)
export OPENCODE_API_KEY="oc-..."

# 智谱 GLM Coding Plan (官方名是 ZAI_CODING_CN_API_KEY；
# 如果你之前已经设了 ZAI_API_KEY 也一样能用，扩展会自动 fallback)
export ZAI_CODING_CN_API_KEY="xxxxx"

# MiniMax Token Plan (官方名是 MINIMAX_CN_API_KEY；
# 已设 MINIMAX_API_KEY 的也兼容)
export MINIMAX_CN_API_KEY="ey..."

# Kimi Code 会员 Key（专用 key sk-kimi-...，不是 Moonshot 开放平台的 sk-...）
export KIMI_API_KEY="sk-kimi-..."

# DeepSeek 按量付费
export DEEPSEEK_API_KEY="sk-..."

# OpenRouter (管理 Key，需去 console 单独创建)
export OPENROUTER_API_KEY="sk-or-v1-..."
```

**pi auth.json 的对应写法**（同一个 env 变量两边都会读）：

```json
{
  "zai-coding-cn": { "type": "api_key", "key": "$ZAI_CODING_CN_API_KEY" },
  "minimax-cn":    { "type": "api_key", "key": "$MINIMAX_CN_API_KEY" },
  "opencode-go":   { "type": "api_key", "key": "$OPENCODE_API_KEY" },
  "deepseek":      { "type": "api_key", "key": "$DEEPSEEK_API_KEY" }
}
```

**别名兼容**（设过旧名字也能用，无需重设）：

| provider | 官方 env (primary) | 别名 (fallback) |
|---|---|---|
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | `ZAI_API_KEY` |
| `minimax-cn` | `MINIMAX_CN_API_KEY` | `MINIMAX_API_KEY` |

其他 provider 没有官方/别名分歧，primary 就是官方名。设过任何名字都能工作（按顺序查找，找到第一个非空就用）。

### 不支持订阅

- **小米 MiMo**：官方仅支持控制台查询，且鉴权依赖登录 cookie（cookie 约 1 天过期）；无公开的按 API key 查询余量接口，所以本扩展**不包含** MiMo。如果你只有 API key、且用量控制足够重要，请考虑在 MiMo 控制台手动查看，或选一个支持 API 查询的替代订阅。

## 实现原理

### 显示位置：自定义 footer（setFooter）

扩展用 `ctx.ui.setFooter()` **完全接管 footer 渲染**（而非 setWidget）：

```typescript
ctx.ui.setFooter((tui, theme, footerData) => ({
  render: (width) => renderFooter(ctx, model, thinkingLevel, footerData, theme, width),
  dispose: () => { /* 清理 */ },
}));
```

这样用量能和 cwd/git/token/模型等原生信息**共享同一行**，并靠右对齐（通过计算宽度 + 空格填充）。footer factory 在 pi 每次重绘时调用，读取模块级缓存的用量数据。

> 早期版本用 `setWidget` + `placement: "belowEditor"`，但无法与原生 footer 信息同排，且依赖 pi-tui 的 `Text` 组件（jiti 编译环境有兼容问题）。最终改为自定义 footer + 原生 ANSI 颜色码，零 pi-tui 运行时依赖。

### 模型自动切换（Adapter Registry）

`model_select` 事件在模型切换时触发，`event.model.provider` 标识当前 provider：

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model.provider = "opencode-go" | "zai-coding-cn" | "minimax" | ...
  // → 据此查 ADAPTERS 注册表决定走哪个 fetcher
});
```

所有 provider 由**自包含的 ADAPTERS 注册表**驱动：

```typescript
const ADAPTERS = {
  opencode: { display: "⚡OC", providerNames: ["opencode-go"], apiKeyEnvVar: "OPENCODE_API_KEY", endpoint: "...", async fetch(apiKey) { ... } },
  zhipu:    { display: "⚡GLM", providerNames: ["zai-coding-cn"], apiKeyEnvVar: "ZAI_API_KEY", endpoint: "...", async fetch(apiKey) { ... } },
  minimax:  { display: "⚡MiniMax", providerNames: ["minimax", "cc-switch-mini-max"], ... },
  kimi:     { display: "⚡Kimi", providerNames: ["kimi", "moonshot", "kimi-code"], ... },
  deepseek: { display: "⚡DeepSeek", providerNames: ["deepseek", "deepseek-cn"], ... },
  openrouter: { display: "⚡OR", providerNames: ["openrouter"], ... },
} as const satisfies Record<string, QuotaAdapter>;
```

模块加载时自动构建 `PROVIDER_TO_SUB` 反向查找表（provider 名 → subscription），所以**加新 provider = ADAPTERS 加一项**，不用动其它地方。

`as const satisfies Record<string, QuotaAdapter>` 双重保险：literal 推断保留具体类型（`display` 是字符串字面量），satisfies 保证每项都满足 `QuotaAdapter` 形状——字段漏写、类型错写会在编译期挂。

### 数据模型：`QuotaBar` 三态判别联合

adapter 的 `fetch()` 只返回 `QuotaBar[]`，**不返回 provider 标签**（display 由框架附上），统一渲染靠 `formatBar` 按 kind 分发：

```typescript
type QuotaBar =
  | { kind: "percentage"; label: string; percent: number; resetsInMs?: number }
  | { kind: "balance";    label: string; amount: number; currency: string }
  | { kind: "text";       label: string; text: string };

function formatBar(bar: QuotaBar): string {
  switch (bar.kind) {
    case "percentage": /* 彩色阈值 + (reset) */
    case "balance":    /* dim + currency + amount */
    case "text":       /* dim + label + text */
    default: { const _exhaustive: never = bar; throw ... }
  }
}
```

加新数据形状 = `QuotaBar` 加一项 + `formatBar` 加一个 case；switch 上的 `never` 守卫保证你不会漏掉。

### API 调用细节

所有 fetcher 共用 `fetchJsonBearer<T>(url, apiKey)` helper（自动 Bearer 鉴权 + 15s 超时 + HTTP 状态检查），仅响应解析是 provider-specific。

**OpenCode Go**（官方未写入文档的 JSON 接口）：

```bash
curl -H "Authorization: Bearer $OPENCODE_API_KEY" \
  https://opencode.ai/zen/go/v1/usage
# → {"usage":{"rolling":{"percent":1,"resetsAt":"..."},"weekly":...,"monthly":...}}
```

**智谱 GLM**（监控 API，非公开文档）：

```bash
curl -H "Authorization: Bearer $ZAI_API_KEY" \
  https://open.bigmodel.cn/api/monitor/usage/quota/limit
# → {"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"percentage":0,"nextResetTime":...},...]}}
# unit=3 是 5 小时窗口，unit=6 是周窗口
```

**MiniMax Token Plan**（MiniMax 官方计费 API）：

```bash
curl -H "Authorization: Bearer $MINIMAX_API_KEY" \
  https://www.minimaxi.com/v1/token_plan/remains
# → {"base_resp":{"status_code":0,"status_msg":"success"},
#    "model_remains":[{"model_name":"general",
#                     "current_interval_remaining_percent":95,
#                     "current_weekly_remaining_percent":58,
#                     "end_time":1730000000000,
#                     "weekly_end_time":1730500000000}, ...]}
```

注意点：

- HTTP 200 即便鉴权失败也会返回，**必须检查 `base_resp.status_code === 0`** 才是真成功。
- `model_name` 一般会有 `general`（共享 chat 配额）和多个专项 bucket（`video`、`speech` 等）。本扩展**只取 `general`**（fallback 首个）以保证 footer 不会胀。
- `current_*_remaining_percent` 字段语义是“剩余”，**与 OpenCode/智谱的“已用”相反**——实现里取 `100 − remaining` 后丢给同一个颜色阈值函数。
- 重置时间优先用 wall-clock epoch（`end_time` / `weekly_end_time`）；若仅有相对倒计时 `remains_time` / `weekly_remains_time` 则退而用之；都没有时显示 `reset`。

**Kimi Code**（月之暗面会员订阅）：

```bash
curl -H "Authorization: Bearer $KIMI_API_KEY" \
  https://api.kimi.com/coding/v1/usages
# → {"usage":{"limit":"100","remaining":"74","resetTime":"2026-02-11T17:32:50Z"},
#    "limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
#               "detail":{"limit":"100","remaining":"85","resetTime":"..."}}],
#    "user":{"membership":{"level":"LEVEL_INTERMEDIATE"}}}
```

注意点：

- **这是 Kimi Code 会员 API，不是 Moonshot 开放平台**——Key 用 `sk-kimi-...` 专属，与 `sk-...`（Open Platform / 按量付费）完全分离，鉴权互不通用。
- `usage` 是整体配额（reset 远在几天后，按社区文档通常是周窗口），`limits[duration=300]` 是 5 小时滚动——本扩展把前者显为 `周:`、后者显为 `5h:`。
- `limit` / `remaining` 都是字符串（API 怪癖），用 `(limit - remaining) / limit * 100` 算已用百分比。

**DeepSeek**（按量付费余额查询）：

```bash
curl -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  https://api.deepseek.com/user/balance
# → {"is_available":true,
#    "balance":[{"currency":"CNY","total_balance":"42.30","granted_balance":"0","topped_up_balance":"42.30"}]}
```

注意点：

- 返回**余额**（金额）而非百分比窗口，与 MiniMax/GLM 的“剩余 %”语义不同——所以走 `balance` kind 的 dim 渲染。
- `currency` 字段为 `CNY` 时显 `¥`，`USD` 时显 `$`，其它代码原样透传（如 `EUR`）。
- `is_available=false` 时把 amount 强制为 0，让 footer 仍然能渲染（`无 Key` 分支留给真的没 key 的场景）。

**OpenRouter**（聚合网关剩余信用）：

```bash
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/key
# → {"data":{"label":"sk-or-v1-...","limit":20,"limit_remaining":8.5,
#              "is_free_tier":false,"usage":11.5}}
```

注意点：

- 用的是**管理 Key**（OpenRouter 控制台单独生成），不是普通 chat API key；放 `OPENROUTER_API_KEY` 这个名字仅为和上层一致。
- `limit_remaining` 是 USD 计价的剩余信用；API 不返回 currency 字段，hardcode `$`。
- `is_free_tier=true` 时显 `免费额度:`，否则显 `额度:`，方便区分账户类型。

### 事件流

```
session_start     → 挂载 footer + 立即查询当前模型用量 + 渲染
model_select      → 更新 activeModel + 强制刷新用量（绕过节流）
thinking_level_select → 更新显示（模型带 thinking 时）
turn_end          → 节流刷新（10s），用量消耗后更新
session_tree      → 节流刷新（5s），回退/分支后更新
session_shutdown  → 清空缓存，防旧数据泄漏到新会话
```

### 健壮性设计

- **无 setInterval**：避免捕获 session ctx 导致的 stale ctx 崩溃（pi 会在 session 替换/reload 后 invalidate 旧 ctx）
- **footer 每次 session_start 重挂**：pi 在 session invalidate 时清掉 custom footer 但不发 `session_shutdown`，所以挂一次标志位会留下空 footer；重挂是安全的，因为 `setExtensionFooter` 是 replace-style（先 dispose 旧的）
- **fetch 序列号守卫**：fast model switching 期间可能 in-flight 的旧响应回来覆盖新数据，用 `++fetchSeq` 配合 `seq !== fetchSeq` 让 stale 响应直接丢弃
- **stale-keep**：fetch 失败时若距上次成功不超过 `STALE_KEEP_MS` (60s)，保留上一次数据并加 `?` 后缀；超出才清空，避免瞬时网络抖动让 footer 闪空白
- **session_shutdown 清理**：新会话不显示旧会话的用量
- **全局正则 lastIndex 安全**：truncate 用非全局正则 `ANSI_ONCE`，避免 `exec` 的 lastIndex 状态污染
- **grapheme 感知宽度**：`Intl.Segmenter` 正确处理 emoji/CJK 组合字符，截断不切断 emoji
- **Adapter exhaustiveness**：`as const satisfies` + `never` 守卫保证新增 provider 时漏掉任一字段会在编译期挂

## 扩展其他订阅

整个流程是**改 1 处 + 加 1 处**，不用动其它代码：

1. **加 endpoint 到 `ENDPOINTS`**（按 id 命名）
2. **加 adapter 到 `ADAPTERS`**——`{ display, providerNames, apiKeyEnvVar, endpoint, fetch }`

`Subscription` 类型 = `keyof typeof ADAPTERS`，**自动跟随**；`PROVIDER_TO_SUB` 反向表**自动重建**；渲染管线 `formatBar` + `refreshQuota` 不用改。

**返回 `QuotaBar` 三选一：**

| 数据形状 | 用哪个 kind | 示例 |
| --- | --- | --- |
| 滚动窗口百分比（5h/周/月）| `percentage` | OpenCode / GLM / MiniMax / Kimi |
| 余额/剩余信用 | `balance` | DeepSeek / OpenRouter |
| 其它（任意自由文本）| `text` | 留给未来的 escape hatch |

模板：

```typescript
// 1. 加 endpoint
const ENDPOINTS = {
  // ...
  yourname: "https://api.example.com/quota",
} as const;

// 2. 加 adapter — fetch 走 fetchJsonBearer helper（自动 Bearer + 15s 超时）
const ADAPTERS = {
  // ...
  yourname: {
    display: "⚡YY",
    providerNames: ["your-provider-name"],
    apiKeyEnvVar: "YOUR_API_KEY",
    endpoint: ENDPOINTS.yourname,
    async fetch(apiKey: string): Promise<readonly QuotaBar[]> {
      const json = await fetchJsonBearer<{ /* 响应 schema */ }>(ENDPOINTS.yourname, apiKey);
      // 构造 QuotaBar 数组：
      //   percentage：{ kind: "percentage", label, percent, resetsInMs? }
      //   balance   ：{ kind: "balance", label, amount, currency }
      //   text      ：{ kind: "text", label, text }
      return [/* ... */];
    },
  },
} as const satisfies Record<string, QuotaAdapter>;
```

REST API 不一样？比如 OpenAI ChatGPT Plus（需要 OAuth + 自定义 header）或多步认证，把 `fetch` 改成自己写 `fetch()` 调用即可——返回 `QuotaBar[]` 的契约不变，渲染层完全无感。

## 验证

```bash
# 手动验证六个接口（key 来自环境变量）
curl -H "Authorization: Bearer $OPENCODE_API_KEY"   https://opencode.ai/zen/go/v1/usage
curl -H "Authorization: Bearer $ZAI_API_KEY"         https://open.bigmodel.cn/api/monitor/usage/quota/limit
curl -H "Authorization: Bearer $MINIMAX_API_KEY"     https://www.minimaxi.com/v1/token_plan/remains
curl -H "Authorization: Bearer $KIMI_API_KEY"        https://api.kimi.com/coding/v1/usages
curl -H "Authorization: Bearer $DEEPSEEK_API_KEY"    https://api.deepseek.com/user/balance
curl -H "Authorization: Bearer $OPENROUTER_API_KEY"  https://openrouter.ai/api/v1/key
```

重启 pi 后，用 `/model` 在 6 个 provider 间切换，footer 显示应随之切换：

- 4 个百分比订阅（OC/GLM/MiniMax/Kimi）显示 `5h:%(...)( 周:%(...))`
- DeepSeek 显示 `余额:¥xx.xx`
- OpenRouter 显示 `额度:$xx.xx`

## 文件结构

```
pi-quota-status/
├── index.ts          # 扩展入口（全部逻辑，单文件，约 600 行）
├── package.json      # 包元信息
├── README.md         # 本文档
├── LICENSE           # MIT
└── .gitignore
```

## License

MIT © huangrx6
