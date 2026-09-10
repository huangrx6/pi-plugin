# Design — pi-notify 0.2.1

> 本文档记录 pi-notify 的内部架构与关键决策，补充 README 的用户视角。
> 扩展独立性铁律：终端通知通过 OSC 控制序列写出，不污染 Pi 状态机。

## 核心架构

```text
runStats (in-memory)           resolveTerminal (env probe)
        ↓                                ↓
   agent_start/end       ──→       terminalPlan
   tool_execution_end                   ↓
   agent_settled                  notificationBytes(plan, ...)
        ↓                                ↓
   publish(body)                     io.write(bytes)
```text

## 触发时机

| Pi event | 用途 |
|---|---|
| `agent_start` | 启动一轮 run 统计（freshStats() 重置） |
| `turn_end` | run.turns++ |
| `tool_execution_end` | run.toolCalls++ + run.uniqueTools.add(name) |
| `agent_end` | 捕获 lastReason（assistant stopReason） |
| `agent_settled` | 仅在 isIdle() && !hasPendingMessages() 时 publish |
| `session_start` | 重置 active / enabled / warned |

`agent_settled` 不在 abort 路径 publish（避免噪音）。Enabled 是会话内开关，配置层面通过 `PI_NOTIFY_PROTOCOL` env 控制。

## OSC 协议子集

`resolveTerminal(env)` 检测终端能力并选择协议：

| 协议 | 触发条件 |
|---|---|
| `osascript` | macOS Terminal.app 或 iTerm2 |
| `powershell` | Windows Terminal |
| `notify-send` | Linux GNOME/KDE desktop |
| `bell` | 任何 TTY（终端响铃，最后回退） |
| `off` | `PI_NOTIFY_PROTOCOL=off` 或非交互模式 |

每条路径产生 `terminalPlan = { protocol, terminal, detectedTransport, transport, blocked, notes }`，`notificationBytes(plan, appName, body, id)` 写入 `io.write()`。

## 安全 sanitize

`body = formatBody(stats, sessionName, outcome, now)` 是纯字符串拼接——但**用户文本不在这里流入**，只统计数字、session 名、agent stopReason。攻击面极小。

但 OSC 控制序列本身可以被提示注入（如果未来扩展让 body 含 LLM 输出）——`sanitizeTerminalText` 剥除 ESC / CSI / OSC / bidi markers 后再用是必要的防御。本扩展目前未传 LLM 内容,防御仅为纵深。

## multiplexer 路由矩阵

`resolveTerminal` 探测常见 multiplexer：

| 标识 | detectedTransport |
|---|---|
| `tmux` | tmux passthrough |
| `screen` | screen passthrough |
| `wezterm` | native OSC |
| `kitty` | kitty text-sizing extension |

非显式支持的 multiplexer 标记为 `blocked: true` + notes 列出原因；UI 提示用户配置。

## /notify 命令

- 无参数 → 状态 summary
- `test [内容]` → 发送测试通知
- `status` / `help` → 诊断详情
- `on` / `off` → 会话内开关

会话内开关独立于 env 配置；env `PI_NOTIFY_PROTOCOL=off` 在启动时已禁用，不会被 on 覆盖。

## 已知边界

- **不与系统 Do Not Disturb 交互**：检测不到 DND；用户需手动开启
- **iTerm2 触发需要权限**：macOS 第一次需要授权通知权限
- **multiplexer 转发丢失**：tmux/screen 转发有时丢失 ESC；notes 提示用户
- **agent_settled 的 timing 窗口**：abort / 立即重 prompt 等情况可能错过触发
  - 这是设计选择：宁可漏发不误发

## 未来可考虑的增强

1. 自定义声音（不同 outcome 播不同提示音）
2. 多 channel（email / Slack / webhook 路由）
3. 按 session id 聚合（同一会话多次通知合并为一条）
