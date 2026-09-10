<!-- markdownlint-disable MD033 MD041 -->
<h1 align="center">pi-footer-composer</h1>

<p align="center">用一份经过校验的 <code>config.json</code> 编排 Pi 终端底栏。</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-555?style=flat-square" />
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-555?style=flat-square" />
</p>

行序、左右位置、标签、字段顺序、外部状态、渲染器、列宽、间距、边框、颜色和溢出方式均由配置决定。紧凑视图使用对齐表格；概览视图使用没有竖线和单元格框的三行信息带。两者都使用统一灰色文字。

## 快速开始

```bash
pi install "$PWD"
```

执行 `/reload`。首次启动会生成完整配置：

```text
<agent-dir>/extensions-data/pi-footer-composer/config.json
```

`<agent-dir>` 跟随 `PI_CODING_AGENT_DIR`，默认是 `~/.pi/agent`。

## 使用

| 命令 | 行为 |
| --- | --- |
| `/footer` | 打开单层视图选择器，并提供“重新加载配置” |
| `/footer compact` | 使用 `views.compact`，自动保存 |
| `/footer overview` | 使用 `views.overview` 信息带，自动保存 |
| `/footer native` | 恢复 Pi 原生底栏，自动保存 |
| `/footer reload` | 校验并应用刚编辑的 `config.json` |

修改配置后执行 `/footer reload` 即可，不必重启 Pi。校验失败时保留当前显示并指出具体配置路径；切换模式前会重新读取文件，避免覆盖外部编辑。

## 布局模型

每个视图包含渲染器、标签开关、可选样式覆盖和有序 `rows`：

```json
{
  "renderer": "table",
  "showLabels": true,
  "rows": [[
    { "label": "项目", "fields": ["project", "branch"] },
    { "label": "模型", "fields": ["model", "provider", "thinking"] }
  ]]
}
```

- `renderer` 可选 `table` 或 `bands`；`showLabels` 控制是否显示格内标签。
- 两个单元格表示左、右两块；用 `null` 保留空的一侧。
- 一个单元格占满整行。
- 调换数组项即可交换左右，调换 `rows` 即可调整上下顺序。
- `fields` 决定格内内容及顺序；`{ "status": "原始 key" }` 可精确引用任意公开状态。
- 空行自动隐藏；长内容按配置折行或省略。

Footer 直接读取 Pi 当前公开的 `key → value` 状态集合，不要求第三方发布者遵循 key 前缀或分类协议。`remaining` 会显示所有尚未显式配置的状态；把某个 key 配到指定单元格后，它会自动从 `remaining` 移出。

完整可复制配置见 [examples/config.json](examples/config.json)，字段、样式和状态选择器说明见 [CONFIG.md](CONFIG.md)，机器校验规则见 [schema/config.schema.json](schema/config.schema.json)。

## 显示边界

默认用主题的 `muted` 灰色显示标签与内容，`dim` 显示边框；不保留上游终端颜色。两列在窄终端下自动变为单列。`table` 提供严格对齐和行间分隔；`bands` 只保留横向节奏，更适合低噪声概览。使用 `wrap` 时保留项目名、Token 数量和诊断详情；使用 `ellipsis` 或设置 `maxCellLines` 可以限制高度。

扩展只读取 Pi 的公开会话、上下文和状态集合。未被当前视图选择的状态不会进入对话内容，也不会被删除；切换到包含它的视图后仍可显示。

## 开发

```bash
npm ci
npm run check
npm test
```

[配置参考](CONFIG.md) · [设计说明](DESIGN.md) · [更新记录](CHANGELOG.md) · [MIT 许可证](LICENSE)
