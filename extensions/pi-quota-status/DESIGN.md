# Design — pi-quota-status 0.2.1

> 本文档记录 pi-quota-status 的内部架构与关键决策，补充 README 的用户视角。
> 扩展独立性铁律：不修改其他扩展的状态、不依赖其命令或事件。

## 架构

三个职责层：

```text
┌─────────────────────────────────────────┐
│ adapter (adapters.ts)                   │ ← 纯函数：fetch + parse
│   每个 provider 一个 ADAPTERS[name]      │   不写状态、不抛副作用
├─────────────────────────────────────────┤
│ monitor (monitor.ts)                    │ ← 单例持有 state + lastSeq
│   createMonitor() 返回 refresh /        │   fetch 取消通过 AbortController
│   invalidate / observePressure 等        │   generation token 防 stale 回调
├─────────────────────────────────────────┤
│ ui (index.ts: publish / /quota 命令)    │ ← 唯一与 Pi 交互的层
│   ctx.setStatus / ctx.ui.select / notify │   渲染色用主题
└─────────────────────────────────────────┘
```text

adapter 错误隔离：单个 provider 失败不污染其它；state.errorText 累积但 state.quotaData 在成功 refresh 时重写。

## adapter 抽象

`ADAPTERS[provider]` 接口：

- `matches(model)`：判定该 adapter 是否适配当前 model（含 endpoint 校验）
- `fetch(apiKey, signal)`：返回 `QuotaBar[]` 或抛错（带错误信息）

当前 adapter 集合：moonshot、siliconflow、deepseek、openai、anthropic、openrouter（含 management balance 子路径）。

## throttling

- `TREE_THROTTLE_MS = 5_000`：session_tree 事件触发 refresh 后，5 秒内不重 fetch
- `TURN_THROTTLE_MS = 10_000`：每轮 turn_end 后至少等 10 秒才允许下次 refresh
- `STALE_KEEP_MS = 60_000`：fetch 错误时保留旧数据 60 秒（避免错误状态闪显）
- `model_select` / `session_start` 强制 invalidate（model 变了则旧 quota 数据无意义）

`monitor.matches(ctx.model) === false` → 立即 publish 空数据 + `state.errorText = "当前端点未适配"`，不浪费 fetch。

## state 形状

```ts
type ExtensionState = {
  identity: string | null;          // 当前 model+endpoint 指纹
  loading: boolean;
  quotaData: { provider: string; bars: QuotaBar[] } | null;
  quotaFetchedAt: number;            // Date.now() at last success
  errorText: string | null;
  lastRefreshError: string | null;
  lastRefreshAt: number;
  fetchSeq: number;                  // generation token
};
```text

state 改变时通过 `controller?.abort()` 取消在飞的 fetch（避免过期 response 覆盖新 state）。

## /quota 命令交互

1. **stats**（默认）：显示当前额度
2. **refresh**：强制 refresh（绕开 throttle）
3. **sources**：数据来源 + 诊断（adapter 名称、API 端点、凭据状态）
4. **account**：OpenRouter 管理账户余额（独立 sub-path）

非 TUI 模式（RPC / json / print）走 `ctx.ui.notify(...)` 单行输出，不开 dialog。

## status key 协议（0.9.0 → 1.0.0）

`extensions/pi-footer-composer` 协议要求 setStatus key 带 `kind:` 前缀：

- `WIDGET_KEY = "quota:main"`：主路径，footer 收 prefix 路由
- `LEGACY_WIDGET_KEY = "quota"`：过渡期双写（1.0.0 移除）

`publish()` 在同一处对两个 key 写同一文本，旧 footer 仍能识别，新 footer 走 prefix 路由。

## 已知边界

- **OpenRouter 管理账户 vs inference 账户是两个不同凭据**：管理账户需要
  `OPENROUTER_MANAGEMENT_KEY`（独立 env），不能复用 inference key
- **隐私**：adapter 凭据来自环境变量（api key），错误消息中已过滤
  但日志可能 leak provider / endpoint 元数据
- **网络错误**：fetch 失败时 state.lastRefreshError 设置；UI 显示 stale +
  "?" 标识，避免错误状态闪显

## 未来可考虑的增强

1. 多 model 配额并列显示（当前只显示当前 model）
2. 预算预警（达到阈值时自动 notify）
3. 历史趋势图（sparkline）
