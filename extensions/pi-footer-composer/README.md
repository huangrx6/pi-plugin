# pi-footer-composer

接管 pi 的 footer，**五行带标签**（单列）：环境、模型、资源（token 用量 + 上下文 + 带 `usage:` 前缀的状态）、集成（带 `integration:` 前缀的状态：MCP / LSP）、配置（带 `config:` 前缀的状态：mode / policy + 未分类兜底）。每行行首是 dim 的 2 字中文标签（`环境：` 等），紧跟首格内容；组内单元格仍用 `│` 分隔，行宽超终端时组内折行，折行内容缩进对齐到标签右侧。

单一职责：它是安装配置里**唯一的 footer 渲染者**（pi 的 `setFooter` 是整体替换语义，两个渲染者会互相覆盖）。

## 效果

五行固定顺序——环境 → 模型 → 资源 → 集成 → 配置，单列；每行首有 dim 标签，紧跟首格；组内单元格用 `│` 分隔；行宽超终端时组内折行，折行内容缩进到标签宽度：

```text
环境： ~/project (main) • 优化
模型： (zai-coding-cn) glm-5.3
资源： ↑1.2k ↓890 R340 CH45% $0.012  12%/128k  ⚡GLM 5h:4%
集成： 🔌 MCP: 3 servers enabled │ LSP Inactive
配置： ◈ mode:帮我批准 │ policy:standard/executing
```

窄终端（折行内容缩进到标签宽度右侧，行不合并）：

```text
环境： ~/project
       (main)
       • 优化
模型： (zai-coding-cn) glm-5.3
资源： ↑1.2k ↓890 R340 CH45%
       12%/128k
       ⚡GLM 5h:4%(4h50m)
集成： 🔌 MCP: 3 servers
       │ LSP Inactive
配置： ◈ mode:帮我批准
       │ policy:standard
```

- **行 1 环境**：cwd（`~` 展开） / 分支 / 会话名
- **行 2 模型**：`(<provider>) <id>` + thinking 级别；多 provider 时带 `(provider)` 前缀
- **行 3 资源**：token 用量 ↑↓RW · cache hit (CH%) · $cost · context (% / window，>70% 黄、>90% 红）· `usage:` 前缀的状态（quota）
- **行 4 集成**：`integration:` 前缀的状态（MCP / LSP）
- **行 5 配置**：`config:` 前缀的状态（mode / policy）+ 未分类状态作为 misc 兜底（不会丢）
- 标签与首格内容用 1 个空格分隔（没有 `│`）；组内折行从下一格开始，缩进对齐到标签宽度；单元格本身超过整行宽度时截断加 `…`

## 数据来源（组合而非依赖）

本扩展**不认识任何其他扩展**——它只消费 pi 的聚合面：

| 内容 | 来源 |
| --- | --- |
| cwd / 会话名 / 用量统计 | `ctx.sessionManager`（entries 的 usage 累加）|
| 上下文占用 | `ctx.getContextUsage()` |
| git 分支 / provider 数 | `footerData.getGitBranch()` / `getAvailableProviderCount()` |
| 扩展状态 | `footerData.getExtensionStatuses()`（即各扩展 `ctx.ui.setStatus()` 发布的文本，**按 key 前缀归入对应行，内容无关**）|

任何扩展只要调 `setStatus` 就会自动出现在表格里——本扩展不知道也不需要知道它们是谁。状态文本里的 ANSI 颜色（如 quota 的阈值配色）原样保留。

### 状态 → 行的路由（key 前缀约定）

扩展通过 `setStatus` 的 key 选择落在哪一行。前缀约定（推荐）：

| Key 形式 | 落点 |
| --- | --- |
| `usage:<name>` | 行 3 资源 |
| `integration:<name>` | 行 4 集成 |
| `config:<name>` | 行 5 配置 |

为了兼容尚未采用前缀约定的包，本扩展对无前缀的 key 也用通用关键词做兜底路由：`mcp` 或包含 `lsp` 的 key → 集成；`mode` 或包含 `policy` 的 key → 配置；`quota` → 资源。其他未匹配 key 一律落配置行的 misc 兜底，不会被静默丢弃。

### 与 pi 原生 footer 的差异

pi 原生 footer 有几处扩展拿不到的内部信息（`(sub)` 订阅标记、`xp` 实验特性指示、auto-compact 开关）：本扩展渲染的是**扩展可见的一切**，这些标记不出现。如果需要它们，卸载本扩展即回到原生 footer（`setFooter(undefined)` 语义）。

## 安装

见仓库根 README 的安装说明（整库安装或单扩展链接均可）。

## 已知限制

- **独占 footer**：`setFooter` 是替换语义。同时安装任何其他会调 `setFooter` 的扩展会与本扩展互相覆盖——本扩展的存在本身就是"footer 渲染者唯一"的约定。
- 用量统计在 `turn_end` 时刷新；分支变更即时（`onBranchChange`）。

## License

MIT © huangrx6
