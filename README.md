<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-plugin</h1>
<p align="center"><strong>让 Pi 的执行过程可理解，让终端中的操作更直接。</strong></p>
<p align="center">八个独立扩展 · 按需安装 · 原生终端交互</p>
<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&amp;style=flat-square&amp;label=CI" alt="CI" /></a>
  <img src="https://img.shields.io/badge/license-MIT-555?style=flat-square" alt="MIT license" />
</p>

## 为终端中的持续工作而设计

把技能直接带入请求，了解模型收到的策略，维护长对话中的上下文，通过当前任务列表推进工作，并随时查看额度、权限和运行结果。

每个扩展都是独立的 Pi 包：拥有自己的入口、配置和测试，没有跨扩展导入或私有事件协议。自定义 Footer 只是可选摘要，详情与主要操作由各扩展独立提供。

## 快速开始

安装整个扩展集合：

```bash
pi install git:github.com/huangrx6/pi-plugin
```

重启 Pi 或运行 `/reload`。整库安装会加载八个扩展；如果只需要其中一部分，使用下方按需安装方式。

> 仓库声明 Node.js `>=22.19`；请同时满足已安装 Pi 宿主的运行要求。自动压缩生命周期在 Node.js 24 的真实 Pi SDK 上验证。

## 扩展目录

### 执行与上下文

| 扩展 | 实际职责 |
| --- | --- |
| `pi-skill-inject` | 在请求中加载技能，保留用户原文，展示可展开的加载记录。 |
| `pi-policy-engine` | 按任务选择流程与执行约束，说明触发原因及实际注入内容。 |
| `pi-auto-compact` | 上下文达到阈值时请求 Pi 原生压缩，并继续被中断的任务。 |
| `pi-mode-switcher` | 按 ask / smart / full 模式决定工具调用是否需要批准。 |
| `pi-todo` | 持久化当前工作区的任务，按任务状态提供操作与简短进度。 |

### 状态与展示

| 扩展 | 实际职责 |
| --- | --- |
| `pi-quota-status` | 查询已适配服务的订阅窗口、账户余额或 API Key 消费上限。 |
| `pi-notify` | 根据最终运行结果发送终端通知，提供发送测试与环境诊断。 |
| `pi-footer-composer` | 提供紧凑、完整和 Pi 原生三种 Footer 显示方式。 |

这些分组帮助选择安装范围，不表示包之间存在依赖。

## 一致的交互方式

**先看当前，再看细节。** 日常入口展示当前任务、额度或最近实际发生的行为；参数、来源和诊断置于次级视图。

**先选对象，再选操作。** 从当前任务进入可用动作，无需先记忆整套命令。取消选择器安静返回。

**状态摘要保持克制。** 活跃任务使用简短编辑器状态条；历史记录按需展开；自定义 Footer 可以停用。

**遵循终端的空间。** 自定义渲染考虑中文、组合字符、emoji 和窄窗口；动态展示文本清理终端控制序列，交互以键盘为主。

完整约定见 [终端交互规范](docs/terminal-ui.md)。

## 按工作场景选择

| 场景 | 可以组合的扩展 |
| --- | --- |
| 理解执行约束与控制工具批准 | policy-engine + mode-switcher |
| 长时间推进代码任务 | auto-compact + todo |
| 提供领域工作方法 | skill-inject |
| 查看额度与等待运行结束 | quota-status + notify |
| 调整终端底部信息密度 | footer-composer |

组合是使用建议；每一项都能独立安装和移除。

<details>
<summary><strong>按需安装与本地开发</strong></summary>

克隆仓库后，使用交互安装器选择扩展及安装目录：

```bash
git clone https://github.com/huangrx6/pi-plugin.git
cd pi-plugin
bash bin/install.sh
```

安装器会在所选目标目录维护仓库副本，并为选中的扩展建立软链接。更新该副本后重新加载 Pi。

也可以在任意一个扩展包目录中执行：

```bash
pi install "$PWD"
```

这会把当前本地包路径登记给 Pi。请先确认当前目录就是要安装的扩展包，而非仓库根目录。本地安装需要保留包所在目录；各包 README 提供自己的配置和使用说明。

</details>

## 配置与数据

全局文件统一收纳到 `~/.pi/agent/extensions-data/`。设置 `PI_CODING_AGENT_DIR` 时，以该目录代替 `~/.pi/agent`。每个扩展使用自己的完整包名，内部按用途分层：

```text
extensions-data/
└── <扩展包名>/
    ├── config.json   # 用户配置，按需创建
    └── state/        # 需要跨会话保留的数据
```

只有需要持久化的扩展才创建目录。配置、任务与执行状态各有归属；目前没有需要落盘的缓存，不预建 `cache/`。项目级配置仍属于项目，Pi 自身的设置、凭据和会话由宿主管理。

<details>
<summary><strong>旧安装迁移</strong></summary>

退出所有 Pi 会话后，从仓库根目录执行：

```bash
node bin/migrate-data.mjs --dry-run
node bin/migrate-data.mjs --apply
```

迁移器先检查冲突与旧数据库占用，再移动已有配置及状态。旧归档保留到 `.backups/`，自动压缩从此只使用配置；迁移后使用更新后的扩展再启动 Pi。详细规则见 [配置迁移](docs/data-migration.md)。

</details>

## 行为边界

策略记录证明已向模型提供哪些要求，不证明模型已经遵守。权限判断是工具调用前的启发式检查，不是操作系统沙箱。

自动压缩依赖 Pi 的摘要与会话机制，不承诺逐字恢复被压缩的内容。取消、新输入和会话变化优先于自动续跑。额度中的订阅窗口、余额与密钥限额分别展示；通知送达受终端、复用器和系统权限影响。

## 开发与验证

进入目标扩展包目录，独立安装依赖并运行检查：

```bash
npm install
npm run check
npm test
```

纯 JavaScript 包的检查与测试无需额外安装运行依赖。CI 按包分别执行语法或类型检查及测试，文档统一使用 Markdown lint。

- [仓库约定](AGENTS.md)：独立性、目录结构、Manifest 和测试规范。
- [终端交互规范](docs/terminal-ui.md)：信息层级、显示边界和验收标准。
- [体验调整记录](docs/ux-improvements.md)：已实施的改动与验证范围。

## License

[MIT](LICENSE) © Huangrx6
