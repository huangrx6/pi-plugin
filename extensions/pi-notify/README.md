<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/notify.svg" alt="pi-notify" width="48" />
</p>

# pi-notify

<p align="center"><strong>运行结束后通知；终端适配可解释、可测试。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
  <img alt="pi" src="https://img.shields.io/badge/pi-%E2%89%A50.84.3-4c1?style=flat-square" />
</p>

Pi 真正停止运行、重试和排队续接之后，发送一条简短通知。`/notify` 查看开关、终端就绪状态和最近结果，也可直接发送测试通知或关闭本会话通知；协议、转发路径和环境说明放在次级诊断页。所有入口由扩展自身提供，不依赖任何状态栏。

## 入口与操作

| 入口 | 行为 |
| --- | --- |
| `/notify` | 打开主视图：测试、开关、终端诊断或返回 |
| `/notify test [内容]` | 发送测试通知（可自定义内容） |
| `/notify status` | 直接查看终端诊断 |
| `/notify on` / `/notify off` | 本会话开启 / 关闭通知 |
| `/notify <message>` | 兼容用法：直接发送自定义通知 |

开关仅影响当前会话；切换会话或重载后恢复默认。无参数入口不会自动发送通知。

## 运行结果

```text
✓ Pi · 已结束 · 3 turns · 5 tools (3 unique) · 1m24s · feature-branch
✗ Pi · 运行失败 · 1 turn · 12s · debug-session
— Pi · 已停止，请检查结果 · 1 turn · 42s · debug-session
```

- 仅在 `agent_settled` 发送；重试与排队续接中间不发送，计数器跨重试保留
- 最终 `stopReason=stop` 表示运行正常结束，不代表业务目标已验证成功
- 过程中的工具错误不把后续正常结束标成失败；错误次数保留在诊断里
- `aborted` 显示为已中断、默认不弹桌面通知，不推断取消原因
- 正文最多 240 个终端显示列；清理 CSI / OSC / 双向控制与换行，按字素保留中文、组合字符与 emoji，不依赖图标字体

只在 `ctx.mode === "tui"`、有 UI 且 stdout 是 TTY 时写入终端。RPC 即使支持对话框也只返回非交互摘要；JSON、print 与重定向输出保持纯净。

## 终端协议

| 终端 | 协议 | 检测依据 |
| --- | --- | --- |
| Ghostty | OSC 9 | `TERM_PROGRAM=ghostty` / `TERM=xterm-ghostty` |
| iTerm2 | OSC 9 | `TERM_PROGRAM=iTerm.app` / `ITERM_SESSION_ID` |
| WezTerm | OSC 777 | `TERM_PROGRAM=WezTerm` / `WEZTERM_PANE` |
| Kitty | OSC 99 | `KITTY_WINDOW_ID` / `TERM=xterm-kitty` |

Kitty 每次通知使用独立 ID，避免不同运行互相覆盖。未知终端不再默认发 OSC 777：识别不出会提示一次，确认实际能力后可显式配置协议。

## 多路复用器

终端协议与转发路径独立选择：

| 环境 | 发送方式 | 条件 |
| --- | --- | --- |
| 直接终端 | 原始 OSC | 宿主终端支持所选协议 |
| tmux | `ESC P tmux; … ESC \`，内层 ESC 翻倍 | tmux 3.3+ 需 `allow-passthrough` 开启 |
| Zellij | 原始 OSC，Zellij 原生转发 | 需支持 `host_notification_protocol` 的版本 |
| GNU screen | `ESC P … ESC \`，不翻倍 ESC | 使用 BEL 结尾的 OSC 9 / 777 |

检测到多个多路复用器标识时不猜测嵌套顺序，先在单层环境验证；显式路径只选一种发送方式。

## 可选配置

无需配置即可在已识别终端工作。环境变量在启动 Pi 前设置：

| 环境变量 | 可选值 | 默认 |
| --- | --- | --- |
| `PI_NOTIFY_PROTOCOL` | `auto` / `osc9` / `osc99` / `osc777` / `bell` / `off` | `auto` |
| `PI_NOTIFY_TRANSPORT` | `auto` / `direct` / `tmux` / `screen` / `zellij` | `auto` |

```bash
PI_NOTIFY_PROTOCOL=osc9 pi     # SSH 隐藏了终端身份，已确认宿主支持 OSC 9
PI_NOTIFY_PROTOCOL=bell pi     # 不用桌面通知，交给终端响铃
PI_NOTIFY_PROTOCOL=off pi      # 持续禁用；/notify on 不会覆盖
```

## 验证边界

自动测试覆盖协议字节、四终端 × 四转发路径组合、控制字符清理、重试与排队续接、失败与中断、RPC / JSON / 非 TTY 隔离、诊断菜单与开关；测试注入输出函数，不向真实终端发送。协议实现依据官方文档，**桌面实际展示仍需在对应终端与系统通知设置下运行 `/notify test` 实机验收**——测试成功只代表控制序列已正确写入终端。

- [Ghostty OSC 9](https://ghostty.org/docs/vt/osc/9) · [iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html) · [Kitty desktop notifications](https://sw.kovidgoyal.net/kitty/desktop-notifications/) · [WezTerm notification handling](https://wezterm.org/config/lua/config/notification_handling.html)
- [tmux passthrough FAQ](https://github.com/tmux/tmux/wiki/FAQ) · [Zellij compatibility](https://zellij.dev/documentation/compatibility.html) · [GNU screen manual](https://www.gnu.org/software/screen/manual/screen.pdf)

## 安装与开发

```bash
pi install git:github.com/huangrx6/pi-plugin
```

安装后重启 Pi 或执行 `/reload`，用 `/notify` 检查识别结果。要求 Node `>=20`；运行时仅用 Node 内置模块，Pi 导入为类型导入，不注册模型工具。

```bash
cd extensions/pi-notify
npm run check && npm test
```

## License

MIT © huangrx6
