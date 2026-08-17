# pi-quota-status

在 pi 的 **footer（底部状态栏）** 显示当前 AI 订阅的剩余用量，并根据当前选择的模型**自动切换**数据源。扩展还完整接管了 footer 渲染——在保留 pi 原生信息（cwd、git 分支、会话名、token 统计、上下文占用、成本、模型名）的同时，把用量靠右显示在状态行。

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
| `deepseek/deepseek-v4-pro`（原生）| 不显示（未识别的订阅源）|

## 支持的订阅

| Provider（模型前缀） | 订阅 | 查询接口 | 环境变量 |
| --- | --- | --- | --- |
| `opencode-go/...` | OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | `OPENCODE_API_KEY` |
| `zai-coding-cn/...` | 智谱 GLM Coding Plan | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `ZAI_API_KEY` |

## 字段含义

| 字段 | 含义 | 来源 |
| --- | --- | --- |
| `5h:` | 5 小时滚动窗口已用百分比 | OpenCode `usage.rolling`；智谱 `TOKENS_LIMIT unit=3` |
| `周:` | 每周窗口已用百分比 | OpenCode `usage.weekly`；智谱 `TOKENS_LIMIT unit=6` |
| `月:` | 每月窗口已用百分比 | OpenCode `usage.monthly`（智谱无月窗口，不显示）|
| `(2h5m)` | 距该窗口重置的倒计时 | `resetsAt` / `nextResetTime` 减去当前时间 |
| `OC` / `GLM` | 订阅来源标识 | opencode-go → OC；zai-coding-cn → GLM |
| `↑1.2k ↓890 R340 W50 CH45%` | 输入/输出/缓存读/缓存写 token + 缓存命中率 | 会话消息 usage |
| `$0.012` | 累计成本 | 会话消息 usage.cost |
| `12%/128k` | 上下文占用百分比 / 窗口大小 | `ctx.getContextUsage()` |

## 颜色高亮

每个窗口的百分比按用量阈值着色：

| 用量 | 颜色 | 含义 |
| --- | --- | --- |
| < 50% | 绿色（`\x1b[32m`）| 安全 |
| 50–79% | 黄色（`\x1b[33m`）| 注意 |
| ≥ 80% | 红色（`\x1b[31m`）| 紧急 |

倒计时和分隔符用灰色（`\x1b[2m` dim）。

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

扩展读取环境变量作为 API Key（**不写入任何文件**）：

```bash
# OpenCode Go 订阅 Key
export OPENCODE_API_KEY="oc-..."

# 智谱 GLM Coding Plan Key
export ZAI_API_KEY="xxxxx"
```

你的 pi 已在用这两个 key 作为 provider 凭证，通常已配置。若无，加到 shell 配置（如 `.zshrc`）后重启 pi。

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

### 模型自动切换

`model_select` 事件在模型切换时触发，`event.model.provider` 标识当前 provider：

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model.provider = "opencode-go" 或 "zai-coding-cn"
  // → 据此选择对应订阅的用量 API
});
```

`PROVIDER_SUBSCRIPTION` 映射表决定哪个 provider 查哪个订阅：

```typescript
const PROVIDER_SUBSCRIPTION = {
  "opencode-go": "opencode",
  "zai-coding-cn": "zhipu",
};
```

### API 调用细节

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
- **footer 防重入**：`footerMounted` 标志确保重复 session_start 不重复挂载 footer
- **session_shutdown 清理**：新会话不显示旧会话的用量
- **全局正则 lastIndex 安全**：truncate 用非全局正则 `ANSI_ONCE`，避免 `exec` 的 lastIndex 状态污染
- **grapheme 感知宽度**：`Intl.Segmenter` 正确处理 emoji/CJK 组合字符，截断不切断 emoji

## 扩展其他订阅

在 `index.ts` 的 `PROVIDER_SUBSCRIPTION` 加映射，并新增 `fetch*` 函数：

```typescript
const PROVIDER_SUBSCRIPTION = {
  "opencode-go": "opencode",
  "zai-coding-cn": "zhipu",
  "your-provider": "your-subscription",  // 新增
};

async function fetchYourSubscription(apiKey: string): Promise<QuotaData> {
  // 调用你的订阅用量 API，解析为 { provider, windows: [{label, percent, resetsInMs}] }
}
```

## 验证

```bash
# 手动验证两个接口（key 来自环境变量）
curl -H "Authorization: Bearer $OPENCODE_API_KEY" https://opencode.ai/zen/go/v1/usage
curl -H "Authorization: Bearer $ZAI_API_KEY" https://open.bigmodel.cn/api/monitor/usage/quota/limit
```

重启 pi 后，用 `/model` 在 opencode-go 与 zai-coding-cn 之间切换，用量显示应随之切换。

## 文件结构

```
pi-quota-status/
├── index.ts          # 扩展入口（全部逻辑，单文件）
├── package.json      # 包元信息
├── README.md         # 本文档
├── LICENSE           # MIT
└── .gitignore
```

## License

MIT © huangrx6
