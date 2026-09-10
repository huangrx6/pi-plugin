# Design — pi-footer-composer 4.0

## 边界

扩展只使用 Pi 的公开会话、上下文和 footer 状态接口。它不读取其他扩展文件，不监听其他扩展事件，也不根据状态 key、前缀或文本猜测来源、类别或严重性。

## 数据流

```text
Pi session / context / status map
                ↓
data.ts       标准化字段与状态快照
                ↓
compose.ts    按 config.json 精确选择与排序
                ↓
table.ts / bands.ts
              按 renderer、style 和终端宽度渲染
                ↓
Pi footer renderer
```

`settings.ts` 是默认配置和配置类型的唯一来源。`config.ts` 负责读取、补齐、验证和原子写入，不参与布局。缺少配置文件时会写出完整默认值，便于用户直接编辑。

## 编排语义

视图由 `renderer`、`showLabels`、可选 `style` 覆盖和有序二维 `rows` 定义。一项表示通栏，两项表示左右单元格，`null` 表示保留空侧。单元格再通过有序 `fields` 组合内建字段、精确状态和剩余状态。

外部状态使用 `{ "status": "原始 key" }` 与 Pi 状态集合完全相等匹配。Footer 不定义发布协议或分类规则。精确状态在解析前全局预留，`remaining` 延迟到全部精确选择器之后执行。隐藏的精确状态仍会预留，从而提供明确的隐藏机制。重复的精确引用属于用户显式选择，允许重复显示。

## 渲染语义

两个 renderer 使用相同的数据与宽度模型。`table` 提供标签列、可选竖向分隔和逐行横线；`bands` 把标签与内容自然排在同一信息带中，不绘制竖线或单元格框。两格使用 `leftRatio` 分配空间，以 `columnGap` 分隔；一格使用完整宽度。左右内容分别折行后取较大高度，保证下一行对齐。低于 `narrowWidth` 时，两格顺序展开为单列。

所有外部文本先去除终端控制序列，再统一应用 `textColor`。边框只使用 `borderColor`。`wrap` 保留完整内容；`ellipsis` 或 `maxCellLines` 明确允许以信息完整性换取固定高度。

## 更新与失败

`/footer reload` 先完整读取和校验新配置，成功后才替换 renderer；失败时继续使用当前配置。模式切换同样先读取磁盘，再只修改 `mode` 并原子保存，避免覆盖外部编辑。

测试分为配置、数据、编排、终端布局和 Pi 生命周期五层。JSON Schema 使用 Draft 2020-12，并通过独立校验器编译和验证完整示例。
