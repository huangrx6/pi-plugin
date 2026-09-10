<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-footer-composer</h1>

<p align="center">按信息层级整理 Pi 终端底栏，随时切回原生视图。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

默认使用三列紧凑布局，把项目、模型和上下文放在固定位置。只保留上下边线，以留白分组，正文跟随主题，分支和平台等次要信息稍暗。完整视图保留分类表格，便于检查详细用量。

## 快速开始

在本扩展包目录执行：

```bash
pi install "$PWD"
```

执行 `/reload` 加载。输入 `/footer` 选择紧凑、完整或 Pi 原生视图，选择后自动保存。

## 紧凑布局

宽窗口分为三列，列位置不随状态变化移动：

| 位置 | 主要信息 | 次要信息 | 下方状态 |
| --- | --- | --- | --- |
| 左列 | 项目目录名 | Git 分支 | 配置和未分类状态 |
| 中列 | 模型名 | 平台、思考等级 | 额度状态 |
| 右列 | 上下文占用、容量 | 最近一次缓存命中率 | 上下文提示、集成状态 |

终端宽度达到 100 列时使用三列，内容区域最多 132 列，避免信息分散到超宽窗口两端。更窄时按组纵向排列。长字段在当前列内按字素折行，中文和 emoji 不拆分；状态不会为了固定高度被截掉。多条状态各占一行，主信息与状态之间保留一行留白。

紧凑模式隐藏完整路径、会话名、累计 Token、费用和自定义 `usage:` 状态。额外的上下文提示与集成状态始终保留；缓存命中率尚无可用数据时不显示。

## 显示方式

| 命令 | 内容 |
| --- | --- |
| `/footer compact` | 三列紧凑布局，窄窗口按组排列；默认模式 |
| `/footer full` | 分类表格，显示完整路径、会话名、用量和全部状态 |
| `/footer native` | 恢复 Pi 原生底栏 |
| `/footer` | 单层选择面板；取消不改变设置 |

完整视图按路径、模型、额度、窗口、用量、集成、状态排列，空类别不显示。窗口占用只显示一次，缓存命中率集中在用量行。

紧凑视图正文使用主题 `text`，次要信息使用 `muted`，上下边线使用 `dim`。上下文超过 70% 使用 `warning`，超过 90% 使用 `error`。完整表格继续使用灰色正文。所有视图都先清理上游终端控制序列，不保留上游着色，也不猜测或改写自由文本状态。

## 持久配置与状态归类

配置文件位于：

```text
<agent-dir>/extensions-data/pi-footer-composer/config.json
```

`<agent-dir>` 跟随 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`。配置修改后执行 `/reload` 生效；切换模式会保留 `statusRoutes`。

```json
{
  "mode": "compact",
  "statusRoutes": {
    "external-service-status": "integration",
    "custom-budget": "quota"
  }
}
```

`statusRoutes` 是可选的精确 key 映射，允许值为 `quota`、`usage`、`context`、`integration`、`config`、`misc`。归类顺序为：用户精确映射 → 已知 `kind:` 前缀 → `misc`。未配置的裸 key 默认进入未分类状态，不做名称子串或文本语义猜测。上例中的 key 应替换为实际发布的状态 key。

| 类别 | 紧凑视图 | 完整视图 |
| --- | --- | --- |
| `quota` | 中列下方 | 额度 |
| `context` | 右列下方 | 窗口 |
| `integration` | 右列下方 | 集成 |
| `config`、`misc` | 左列下方 | 状态 |
| `usage` | 隐藏 | 用量 |

发布者可以直接使用 `setStatus("<kind>:<subkey>", text)`。底栏只读取 Pi 公开状态集合；同组按 key 排序，清空状态后不再占位。

只有整条上下文状态是 `Context N%` 或 `上下文 N%`，且与宿主数据四舍五入一致时才去重。附带暂停、失败等文字的状态完整保留。上下文未知时显示 `?`，不显示为零。

## 边界与开发

本扩展负责底栏，不修改输入框、任务组件和终端背景。Pi 自定义底栏采用替换语义，同时启用多个渲染器时可能互相覆盖。需要原生内部标记时使用 `/footer native`。

```bash
npm ci
npm run check
npm test
```

`compact.ts` 实现自适应三列布局，`grid.ts` 实现完整表格，`routing.ts` 负责精确映射与前缀归类，`index.ts` 收集公开状态并接入生命周期。

[设计说明](DESIGN.md) · [更新记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
