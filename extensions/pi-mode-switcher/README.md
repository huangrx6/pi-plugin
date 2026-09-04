<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-mode-switcher</h1>

<p align="center">在工具执行前切换确认策略：ask、smart、full。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

通过 Pi 原生确认框控制工具调用。日常使用默认的 `smart`，需要逐项检查时切换到 `ask`；当前模式会保存，下一次启动继续使用。

## 快速开始

在本扩展包目录中执行，单独安装此扩展：

```bash
pi install "$PWD"
```

重启 Pi 或执行 `/reload`。输入 `/mode` 打开模式选择器，或用 `/mode ask` 直接切换。

## 选择确认策略

| 命令 | 行为 |
| --- | --- |
| `/mode ask` | 已知只读工具直接通过；命中写入判定的 Bash 和其他工具请求确认 |
| `/mode smart` | 默认模式；仅对命中高风险判定的 Bash 请求确认 |
| `/mode full` | 本扩展不请求确认，所有工具直接通过 |
| `/mode` | 查看当前模式并选择；取消保留原模式 |

确认框显示本次操作的命令、路径、URL 或查询摘要。拒绝后阻止该次工具执行，并把原因交给模型，不直接终止整个任务。

## 实际行为

| 调用类型 | ask | smart | full |
| --- | --- | --- | --- |
| `read`、`ls`、`grep`、`find`、`glob` | 通过 | 通过 | 通过 |
| `write`、`edit`、`apply_patch` | 确认 | 通过 | 通过 |
| 网络工具、MCP 工具、未知工具 | 确认 | 通过 | 通过 |
| Bash：`ls`、`cat`、`git status` | 通过 | 通过 | 通过 |
| Bash：`mkdir`、普通 `rm`、`git push` | 确认 | 通过 | 通过 |
| Bash：`rm -rf`、`git reset --hard`、`git push --force` | 确认 | 确认 | 通过 |

表格描述典型输入；具体 Bash 判定由命令文本决定。

### Bash 识别的范围

单条 Bash 命令使用**写入黑名单**：检查文件变更、重定向、部分 Git 操作、安装命令和常见网络命令。没有命中规则的单条命令可能直接通过，例如 `python3 script.py`，即使脚本内部会写文件。

复合命令按 `&&`、`||`、`;`、管道、换行、命令替换拆段。`ask` 对其中无法匹配只读规则的片段请求确认；`smart` 仍只检查高风险规则。管道连接到解释器会触发风险确认。

这是一组文本启发式，不解析完整 Shell 语法，也不检查脚本内容。它无法保证识别所有危险命令；`ask` 不代表所有写入必经批准，`smart` 不代表通过的操作已经安全验证。操作系统权限和沙箱隔离需要在运行环境中设置。

## 状态与配置

模式保存到 `~/.pi/agent/extensions-data/pi-mode-switcher/config.json`。设置 `PI_CODING_AGENT_DIR` 时，目录跟随宿主配置：

```json
{
  "mode": "smart"
}
```

新配置不存在时，兼容读取 agent 目录下的旧 `mode-switcher.json`；切换模式会创建新目录并写入新配置。新配置已经存在时始终以它为准，不回退到旧权限选择。文件不存在、内容无效或读取失败时使用 `smart`。切换通过 `/mode` 完成；写入配置失败不会中断当前会话，但下次启动可能无法恢复本次选择。

界面发布简短的权限状态。查看与切换始终可通过 `/mode` 完成。确认框中的动态内容先清理控制序列，再按显示宽度裁切，避免长命令和路径撑开界面。

## 开发

在本包目录运行：

```bash
npm ci
npm run check
npm test
```

`index.ts` 负责命令、权限判定和配置持久化；`display.ts` 负责确认框文本。测试覆盖复合命令、删除目标、宽度裁切及模式交互。

[更新记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
