# pi-footer-composer

接管 pi 的 footer，**一个内容一行**（单列多行）：环境、用量统计、上下文占用、模型、以及**每一个扩展发布的状态**各占一行，行内单元格用 `│` 分隔，组太宽时组内折行。

单一职责：它是安装配置里**唯一的 footer 渲染者**（pi 的 `setFooter` 是整体替换语义，两个渲染者会互相覆盖）。

## 效果

一个内容一行——环境、用量、上下文、模型、扩展状态各占一行，单列多行；组内单元格用 `│` 分隔，组太宽时组内折行：

```text
~/project (main) • 优化
↑1.2k ↓890 R340 CH45% $0.012
12%/128k
(zai-coding-cn) glm-5.3
⚡GLM 5h:4%(4h50m) 周:8%(97h40m)? │ policy:standard
```

窄终端（组内折行，内容行不合并）：

```text
~/project (main)
• 优化
↑1.2k ↓890 R340 CH45%
$0.012
12%/128k
(zai-coding-cn) glm-5.3
⚡GLM 5h:4%(4h50m)
周:8%(97h40m)? │ policy:standard
```

- 行顺序：**环境**（cwd / 分支 / 会话名）→ **用量**（↑↓RW / CH / $）→ **上下文**（percent/window，>70% 黄、>90% 红）→ **模型**（含 thinking 级别；多 provider 时带 `(provider)` 前缀）→ **扩展状态**（按 key 排序，一格一个）
- 组宽超过终端时组内折行；单元格本身超过整行宽度时截断加 `…`

## 数据来源（组合而非依赖）

本扩展**不认识任何其他扩展**——它只消费 pi 的聚合面：

| 内容 | 来源 |
| --- | --- |
| cwd / 会话名 / 用量统计 | `ctx.sessionManager`（entries 的 usage 累加）|
| 上下文占用 | `ctx.getContextUsage()` |
| git 分支 / provider 数 | `footerData.getGitBranch()` / `getAvailableProviderCount()` |
| 扩展状态 | `footerData.getExtensionStatuses()`（即各扩展 `ctx.ui.setStatus()` 发布的文本，**一格一个，内容无关**）|

任何扩展只要调 `setStatus` 就会自动出现在表格里——本扩展不知道也不需要知道它们是谁。状态文本里的 ANSI 颜色（如 quota 的阈值配色）原样保留。

### 与 pi 原生 footer 的差异

pi 原生 footer 有几处扩展拿不到的内部信息（`(sub)` 订阅标记、`xp` 实验特性指示、auto-compact 开关）：本扩展渲染的是**扩展可见的一切**，这些标记不出现。如果需要它们，卸载本扩展即回到原生 footer（`setFooter(undefined)` 语义）。

## 安装

见仓库根 README 的安装说明（整库安装或单扩展链接均可）。

## 已知限制

- **独占 footer**：`setFooter` 是替换语义。同时安装任何其他会调 `setFooter` 的扩展会与本扩展互相覆盖——本扩展的存在本身就是"footer 渲染者唯一"的约定。
- 用量统计在 `turn_end` 时刷新；分支变更即时（`onBranchChange`）。

## License

MIT © huangrx6
