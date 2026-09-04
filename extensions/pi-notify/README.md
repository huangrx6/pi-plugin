<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-notify</h1>

<p align="center">Pi 运行结束时发送终端通知，并提供可核对的发送诊断。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

离开当前终端后，也能知道 Pi 是否已经结束运行。通知等待重试和排队续接完成；终端识别、测试与会话开关集中在 `/notify`，发送结果始终可以查看。

## 快速开始

在本扩展包目录中执行，单独安装此扩展：

```bash
pi install "$PWD"
```

重启 Pi 或执行 `/reload`，输入 `/notify`，选择「发送测试通知」。扩展要求 Pi `>=0.84.3`；桌面横幅是否出现取决于终端与系统通知设置。

## 日常使用

默认开启通知。主视图显示开关、终端是否可以发送、最近运行与最近发送结果。协议和转发路径放在「查看终端诊断」中，界面使用 Pi 原生选择器与当前主题。

| 操作 | 结果 |
| --- | --- |
| `/notify` | 打开主视图，测试通知或切换本会话开关 |
| `/notify test [内容]` | 发送测试通知，可指定正文 |
| `/notify status` | 查看终端、协议、转发路径和最近结果 |
| `/notify on`、`/notify off` | 开启或关闭当前会话通知 |
| `/notify help` | 查看诊断及常用命令 |
| `/notify <内容>` | 兼容的自定义测试通知入口 |

无参数入口只打开菜单。会话开关不写入配置；切换会话或重载后恢复默认。设置 `PI_NOTIFY_PROTOCOL=off` 可以持续禁用，`/notify on` 不会覆盖这个环境设置。

## 何时通知

扩展在 `agent_settled` 且 Pi 已空闲、没有待处理消息时判断运行结果。重试和排队续接期间保留累计统计，不在中间发送完成通知。

| 最终状态 | 行为 |
| --- | --- |
| 正常结束 `stop` | 发送「已结束」 |
| 错误结束 `error` | 发送「运行失败」 |
| 中断 `aborted` | 记录「已中断」，不发送桌面通知 |
| 其他或未知原因 | 发送「已停止，请检查结果」 |

「已结束」只表示运行停止，不证明业务目标已经验收。过程中出现过工具错误，但最终正常结束时，仍按正常结束处理；诊断保留工具错误次数。扩展不会推断中断来自用户取消还是其他原因。

通知正文包含回合数、工具调用数、不同工具数、耗时和可用的会话名称。正文最多 240 个终端显示列；清理终端转义与双向控制字符，将换行合并，并按字素裁切中文、组合字符与 emoji。

## 终端与转发

终端协议和多路复用器路径分别识别。已识别的直接终端通常无需配置。

| 终端 | 默认协议 | 识别依据 |
| --- | --- | --- |
| Ghostty | OSC 9 | `TERM_PROGRAM=ghostty` 或 `TERM=xterm-ghostty` |
| iTerm2 | OSC 9 | `TERM_PROGRAM=iTerm.app` 或 `ITERM_SESSION_ID` |
| WezTerm | OSC 777 | `TERM_PROGRAM=WezTerm` 或 `WEZTERM_PANE` |
| Kitty | OSC 99 | `KITTY_WINDOW_ID` 或 `TERM=xterm-kitty` |

未知终端不会被假定为支持某种桌面通知协议。扩展提示诊断信息后，可显式配置已确认支持的协议，或降级为响铃。Kitty 使用独立通知 ID，避免不同运行互相覆盖。

<details>
<summary>tmux、Zellij、GNU screen 与嵌套限制</summary>

| 路径 | 实现 | 使用条件 |
| --- | --- | --- |
| 直接终端 | 原始 OSC | 终端支持所选协议 |
| tmux | DCS passthrough，内层 ESC 翻倍 | tmux 3.3+ 需要 `allow-passthrough=on` 或 `all` |
| Zellij | 原始 OSC，由 Zellij 原生转发 | 需要支持 `host_notification_protocol` 的版本；该项为 `off` 时禁用转发 |
| GNU screen | DCS 封装，内层 ESC 不翻倍 | 仅封装以 BEL 结尾的 OSC 9 或 OSC 777 |

Zellij 自动模式使用 OSC 9，由宿主转发配置决定外层协议。GNU screen 下，Kitty 自动降为兼容的 OSC 9；显式要求 OSC 99 会被阻止，避免内层终止符破坏封装。

检测到多个复用器标识，或只有含糊的 `TERM=screen…` 而无法确定路径时，不猜测嵌套顺序。应先在单层环境测试，或明确设置发送路径；显式路径只选择一层封装，不提供任意嵌套支持。扩展不自动修改复用器配置。

</details>

## 可选配置

环境变量在启动 Pi 前设置。本扩展不读写独立配置文件，运行统计与发送诊断保存在内存中，无需创建数据目录。

| 变量 | 可选值 | 默认 |
| --- | --- | --- |
| `PI_NOTIFY_PROTOCOL` | `auto`、`osc9`、`osc99`、`osc777`、`bell`、`off` | `auto` |
| `PI_NOTIFY_TRANSPORT` | `auto`、`direct`、`tmux`、`screen`、`zellij` | `auto` |

```bash
PI_NOTIFY_PROTOCOL=osc9 pi
PI_NOTIFY_PROTOCOL=bell pi
PI_NOTIFY_PROTOCOL=off pi
```

第一条适用于终端身份被 SSH 等环境隐藏、且已确认宿主支持 OSC 9 的情况。`bell` 将响铃交给当前终端或复用器处理，不保证桌面横幅。无效的协议或转发配置会阻止发送，并在诊断中说明原因。

## 诊断与验证边界

只有在 Pi 交互终端模式、有 UI 且 stdout 为 TTY 时才写入终端控制序列。RPC 使用非交互摘要；JSON、print 和重定向输出不写入通知控制序列。扩展不注册模型工具，不执行系统通知命令。

`/notify test` 显示「已写入」表示控制序列已经交给终端，**无法确认系统实际展示或用户收到通知**。未显示横幅时，先核对 `/notify status` 中的协议和路径，再检查宿主终端、复用器及系统通知设置。

自动测试注入输出函数，不向真实终端发送。覆盖协议字节、转发组合、文本清理、重试与排队续接、结束原因、非交互隔离以及菜单开关；不同终端的实际桌面展示仍需实机验收。

<details>
<summary>官方协议与兼容资料</summary>

- [Ghostty OSC 9](https://ghostty.org/docs/vt/osc/9)
- [iTerm2 Escape Codes](https://iterm2.com/documentation-escape-codes.html)
- [Kitty Desktop Notifications](https://sw.kovidgoyal.net/kitty/desktop-notifications/)
- [WezTerm Notification Handling](https://wezterm.org/config/lua/config/notification_handling.html)
- [tmux Passthrough FAQ](https://github.com/tmux/tmux/wiki/FAQ)
- [Zellij Compatibility](https://zellij.dev/documentation/compatibility.html)
- [GNU screen Manual](https://www.gnu.org/software/screen/manual/screen.pdf)

</details>

## 开发

在本扩展目录中执行：

```bash
npm ci
npm run check
npm test
```

包声明 Node.js `>=20`；实际运行还需满足所用 Pi 版本的要求。运行时只使用 Node 内置模块，Pi 导入为类型导入。修改代码后执行 `/reload`。

[变更记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
