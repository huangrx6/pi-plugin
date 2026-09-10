# Footer 配置参考

配置位于 `<agent-dir>/extensions-data/pi-footer-composer/config.json`。首次加载自动写入完整默认值；也可以只覆盖需要修改的部分。执行 `/footer reload` 校验并应用修改。

## 数据来源

Footer 从 Pi 的公开接口读取两类数据：

- 内建数据：项目、路径、分支、会话、模型、平台、思考等级、上下文和用量。
- 状态集合：Pi 当前公开的全部 `key → value`。

状态 key 没有命名约定，也不会按前缀、文本或发布者分类。配置写入原始 key 后，Footer 直接取得对应 value；任何未配置的 key 都可以由 `remaining` 显示。

## 顶层结构

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `mode` | `compact` / `overview` / `native` | 当前视图 |
| `style` | 对象 | 控制颜色、边框、间距、列宽和溢出 |
| `views.compact` | 视图 | 紧凑模式的行与单元格 |
| `views.overview` | 视图 | 概览信息带的行与单元格 |

未知配置项会被拒绝，避免拼写错误被静默忽略。

## 行与单元格

`rows` 按数组顺序从上到下渲染。一行最多两个位置：

```json
{
  "views": {
    "compact": {
      "renderer": "table",
      "showLabels": true,
      "rows": [
        [
          { "label": "项目", "fields": ["project", "branch"] },
          { "label": "诊断", "fields": [{ "status": "editor-diagnostics" }] }
        ],
        [null, { "label": "构建", "fields": [{ "status": "build-monitor" }] }],
        [{ "label": "其他", "fields": ["remaining"] }]
      ]
    }
  }
}
```

- `[left, right]`：左右两块。
- `[null, right]`：左侧留空，内容固定在右侧。
- `[cell]`：单元格横跨整行。
- `hidden: true`：不渲染该格；其中配置的状态 key 仍从 `remaining` 排除。
- 调换单元格、行或字段的数组位置，即可调整左右、上下及格内顺序。

每个视图还可以配置：

| 配置 | 用途 |
| --- | --- |
| `renderer` | `table` 为带对齐分隔的表格；`bands` 为无竖线的信息带 |
| `showLabels` | 是否显示每格的 `label` |
| `style` | 仅覆盖该视图需要不同的全局样式项 |

## 内建字段

| 字段 | 内容 |
| --- | --- |
| `project` | 当前工作目录名 |
| `cwd` | 当前完整路径，主目录缩写为 `~` |
| `branch` | Git 分支 |
| `session` | 会话名 |
| `model` | 模型 ID |
| `provider` | 模型平台 |
| `thinking` | 思考等级 |
| `context` | 上下文占用比例和窗口容量 |
| `cacheHit` | 最近一条助手消息的缓存命中率 |
| `input` / `output` | 会话累计输入、输出 Token，显示为 `↑` / `↓` |
| `cacheRead` / `cacheWrite` | 会话累计缓存读写 Token，显示为 `读` / `写` |
| `cost` | 会话累计费用 |
| `remaining` | 所有尚未被精确选择的状态 value |

内建字段可以写成对象，为非空值添加前后文，或者为空值提供替代文本：

```json
{
  "source": "branch",
  "prefix": "分支  ",
  "suffix": "",
  "empty": "无分支"
}
```

## 外部状态

通过 `status` 写入 Pi 状态集合里的原始 key：

```json
{ "status": "publisher-owned-key" }
```

Footer 使用完全相等匹配，不解释 key，也不要求 `kind:name` 格式。匹配到的 value 会显示在当前位置；未匹配到时该字段为空。状态对象同样支持 `prefix`、`suffix` 和 `empty`。

所有显式 `status` 会先在整个视图中预留，然后才解析 `remaining`。因此即使 `remaining` 位于前一行，把某个 key 添加到后面的单元格也会自动完成移动，不会重复显示。

## 样式

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `textColor` | `muted` | 标签和内容的主题颜色，可选 `muted`、`dim`、`text` |
| `borderColor` | `dim` | 边框主题颜色 |
| `borders` | `all` | `all` 显示行间边框，`outer` 只显示上下边框，`none` 不显示横向边框 |
| `labelDivider` | `true` | 是否显示 label 与内容之间的竖线 |
| `labelWidth` | `4` | label 最小宽度，取值 0–16 |
| `columnGap` | `3` | 左右两块之间的空格数，取值 0–16 |
| `fieldGap` | `3` | 同一格中字段之间的空格数，取值 0–16 |
| `leftRatio` | `0.5` | 左侧宽度比例，取值 0.2–0.8 |
| `narrowWidth` | `72` | 低于该终端宽度时转为单列 |
| `overflow` | `wrap` | `wrap` 完整折行，`ellipsis` 每格只显示一行并省略 |
| `maxCellLines` | `0` | 每格最大行数；`0` 表示不限，超出时显示省略号 |

`overflow: "ellipsis"` 优先于 `maxCellLines`。左右同一行使用较高单元格的高度，保证下一行对齐。视图内的 `style` 覆盖顶层同名值，因此紧凑表格和概览信息带可以使用不同边框与间距。

## 校验

运行时校验和 [JSON Schema](schema/config.schema.json) 都拒绝未知字段、非法来源和超出范围的样式值。`/footer reload` 失败时不会替换当前 renderer；启动时配置无效则使用内置默认布局，并显示错误路径。

完整示例在 [examples/config.json](examples/config.json)。4.0.0 只接受 `compact`、`overview` 和 `native`，不再保留旧 `full` 视图。外部状态使用 `{ "status": "原始 key" }`。
