<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-auto-compact</h1>

<p align="center"><strong>到达阈值，自动压缩。继续当前任务。</strong></p>

<p align="center">为 Pi 长对话提供可配置的压缩时机，以及压缩后的任务续跑。</p>

<p align="center">
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/node-%E2%89%A522.19-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

## 开始使用

需要 Node.js 22.19+ 与 Pi。在本扩展目录执行：

```bash
pi install "$PWD"
```

在 Pi 中重新加载扩展，输入 `/context`。面板提供三项操作：查看用量、暂停或恢复、调整阈值。

全新安装默认在 **总上下文窗口占用达到 60%** 时请求 Pi 原生压缩。压缩成功且没有新输入接管时，自动继续被中断的任务。

## 日常体验

| 时刻 | 扩展的行为 |
| --- | --- |
| 下一次模型请求前，用量达到阈值 | 请求 Pi 原生压缩，保留当前目标、约束与未完成步骤 |
| 压缩成功，任务可以继续 | 发送一次隐藏的继续指令，优先完成下一步 |
| 出现新输入、切换模型或会话分支 | 放弃过期续跑，让当前操作接管 |
| 压缩失败或取消 | 显示结果，不自动重试或继续 |
| Pi 尚未提供完整用量 | 显示“未知”，等待数据后再判断 |

`/context` 显示总窗口占用、当前阈值和最近一次压缩结果。压缩结果也写入 Pi 会话活动记录，展开可查看压缩前后 token 信息；压缩后用量不可得时明确显示“未知”。状态栏只是摘要，操作不依赖它。

<details>
<summary>直接命令</summary>

| 命令 | 用途 |
| --- | --- |
| `/context stats` | 查看当前用量与压缩状态 |
| `/context pause` | 暂停后续自动压缩 |
| `/context resume` | 恢复自动压缩 |
| `/context threshold 60` | 将本次会话阈值设为总窗口的 60% |

阈值接受大于 0、小于 100 的百分比，可带小数。命令修改仅在本次会话生效，重新加载后使用配置文件。压缩期间调整设置会影响后续触发，当前压缩仍可完成并续跑。

</details>

## 配置

全局配置：

```text
~/.pi/agent/extensions-data/pi-auto-compact/config.json
```

```json
{
  "enabled": true,
  "thresholdPercent": 60
}
```

配置文件可省略，默认值如上。设置 `PI_CODING_AGENT_DIR` 时，全局路径相对于该目录。受信任项目还可使用 `.pi/auto-compact.json` 覆盖全局设置；未受信任项目的配置不会读取。

扩展只读取配置，**不创建数据库、正文归档、缓存或额外状态目录**。对话、压缩摘要和活动记录由 Pi 自己保存。

旧版 `pi-context-qos` 的配置、归档和命令不属于当前扩展。当前运行时只读取上面的两个新配置位置；需要保留旧数据时请在扩展之外自行归档，避免旧格式继续影响当前行为。

## 边界

压缩内容和模型调用由 Pi 执行，可能产生模型请求费用。扩展不改写工具输出，不管理额外证据层，也不保证每个历史细节都保留在原生压缩摘要中。

自动续跑仅适用于本扩展触发的压缩。手动 `/compact` 或 Pi 自己发起的压缩沿用宿主行为。一次自动压缩后，只有观察到用量降回阈值以下，或收到新输入、重新调整设置，才允许再次尝试，避免压缩与续跑循环。

## 开发

```bash
npm install
npm run check
npm test
```

检查同时覆盖本地类型声明与已安装 Pi SDK。测试包含离线的真实 Pi 压缩生命周期、取消与新输入接管、阈值换算、配置优先级以及终端文本渲染。

[实现设计](DESIGN.md) · [版本记录](CHANGELOG.md) · [MIT License](LICENSE)
