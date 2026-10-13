# Design — pi-notify 0.3.0

> 本文档记录 pi-notify 的内部架构与关键决策，补充 README 的用户视角。
> 扩展独立性铁律：终端通知通过 OSC 控制序列写出，不污染 Pi 状态机。

## 核心架构

```text
runStats (in-memory)      resolveTerminal (env probe)         resolveSystemNotifier(env, platform, available)
        ↓                          ↓                                       ↓
   agent_start/end     ──→     terminalPlan   ──→ system ──→        systemCommand(backend, title, body)
   tool_execution_end              ↓                                       ↓
   agent_settled            notificationBytes(plan, ...)              io.run(file, args)
        ↓                          ↓
   publish(body)               io.write(bytes)
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
| `osc9` | Ghostty / iTerm2（`TERM_PROGRAM` 或 `TERM` 身份回退） |
| `osc99` | Kitty |
| `osc777` | WezTerm |
| `bell` | 显式 `PI_NOTIFY_PROTOCOL=bell`，或确认终端只支持响铃时的降级 |
| `system` | 已识别但没有通知协议的终端（JetBrains 内嵌终端）；显式 `PI_NOTIFY_PROTOCOL=system`；未识别终端 + `PI_NOTIFY_COMMAND` |
| `off` | `PI_NOTIFY_PROTOCOL=off` 或非交互模式 |

每条路径产生 `terminalPlan = { protocol, terminal, detectedTransport, transport, blocked, notes }`，`notificationBytes(plan, appName, body, id)` 写入 `io.write()`。

## 系统通知降级

终端本身没有通知协议时（JetBrains 内嵌终端只实现了 OSC 9;4 进度），继续只写字节等于静默失败。`system` 协议因此走一条独立路径：`resolveSystemNotifier()` 选后端（macOS `osascript` / Linux `notify-send` / 用户命令），`systemCommand()` 生成 argv，`io.run()` 启动程序（5s 超时、`windowsHide`）。

关键决策：

- **在 pi-notify 内实现，不另开扩展。** 通知的触发、统计、去重和诊断已经只有一个所有者；独立扩展要么重复判定终端能力（等于跨扩展耦合），要么和 pi-notify 同时发两条通知。
- **只在“已知没有协议”时自动降级。** JetBrains 的能力缺失有依据（官方只实现了 OSC 9;4），自动降级不会误导；未知终端保持保守，需 `PI_NOTIFY_COMMAND` 或显式 `system` 才执行命令。显式协议（含 `bell` / `off`）永远优先于该默认。
- **`TERMINAL_EMULATOR` 优先于 `TERM_PROGRAM`。** IDE 内嵌终端自己设置前者；后者可能是 IDE 从外层 shell 继承的（从 Ghostty 启动 IDEA 就会发生），此时按 `TERM_PROGRAM` 判成 Ghostty 会向一个不解析 OSC 9 的终端写字节。
- **文本只作为 argv 数据。** 不经过 shell，不拼接进 AppleScript 源码：osascript 用 `on run argv` 脚本接收标题与正文，正文里的引号、反引号、`$( )`、分号只能作为文本出现。
- **退出码不是送达证明。** 终端路径的“已写入”与系统路径的“退出 0”都只证明请求已交出；两者都在诊断里如实描述。
- **不用判别联合表达结果。** 本仓编译未开 `strictNullChecks`，按布尔判别属性收窄不可用（`NotifierResolution` 因此用可选字段，调用方判 `notifier` / `error`）。

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

- **系统命令不重试**：终端字节写入失败可重试，系统路径只运行一次并记录退出码
- **Windows 没有内置后端**：需要显式 `PI_NOTIFY_COMMAND` 与 `PI_NOTIFY_COMMAND_ARGS`
- **只在交互终端模式发送**：RPC / JSON / print 不执行系统命令，保持无副作用
- **不与系统 Do Not Disturb 交互**：检测不到 DND；用户需手动开启
- **iTerm2 触发需要权限**：macOS 第一次需要授权通知权限
- **multiplexer 转发丢失**：tmux/screen 转发有时丢失 ESC；notes 提示用户
- **agent_settled 的 timing 窗口**：abort / 立即重 prompt 等情况可能错过触发
  - 这是设计选择：宁可漏发不误发

## 未来可考虑的增强

1. 自定义声音（不同 outcome 播不同提示音）
2. 多 channel（email / Slack / webhook 路由）
3. 按 session id 聚合（同一会话多次通知合并为一条）
