# 配置参考

配置位于 `<agent-dir>/extensions-data/pi-footer-composer/config.json`，修改后运行 `/footer reload`。完整默认值见 [examples/config.json](examples/config.json)。配置严格校验未知字段、文本控制符、重复状态 key 和数值范围；失败时保留现有显示。

```json
{
  "version": 5,
  "mode": "custom",
  "icons": "unicode",
  "style": {
    "textColor": "muted",
    "borderColor": "dim",
    "gap": 5,
    "panelWidth": 60
  },
  "more": {
    "sections": [
      { "label": "状态", "status": "access-status" },
      { "label": "额度", "status": "quota-status" },
      { "label": "诊断", "status": "diagnostics" },
      { "label": "策略", "status": "policy-status", "hidden": true }
    ],
    "includeUnmapped": false
  }
}
```

示例中的 `status` 是占位 key，需要换成发布者传入 Pi 公开状态集合的精确 key。它们不对应固定扩展，未发布时显示“暂无状态”。

| 字段 | 默认 | 范围 / 说明 |
| --- | --- | --- |
| `version` | `5` | 配置版本 |
| `mode` | `custom` | `custom` 或 `native` |
| `icons` | `unicode` | `unicode` 或 `ascii` |
| `style.textColor` | `muted` | `muted`、`dim`、`text` |
| `style.borderColor` | `dim` | 同上 |
| `style.gap` | `5` | 段间空格，1–8 |
| `style.panelWidth` | `60` | 卡片宽度，28–100 列；终端不足时自动缩小 |
| `more.sections` | `[]` | 按序展示的 `{label,status,hidden?}` 数组 |
| `more.includeUnmapped` | `false` | 是否在更多里追加未配置的状态 |

`hidden: true` 隐藏该状态，并阻止它从未映射项中重复出现。配置只决定展示，不删除公开状态，也不影响发布者。上游的颜色与终端控制符被移除，多行文本保留并折行，长文本优先沿空白和分隔符换行；长内容可以滚动，不永久截断。显式开启 `includeUnmapped` 时，内容统一归入“其他”，不把原始 key 当作标题。

面板默认宽 60 列，左右内边距为 3 列，顶部、底部及字段之间留一行空白。短记录与额度续项共用右边界；长段落在右侧内容区连续折行，各续行左沿一致，不在自动换行之间插入空白。逗号、中文顿号和分号可作为列表换行点；单个超长名称按完整字素折行。底栏为分隔线与靠左摘要两行，上下不额外留空白；浮层紧邻底栏分隔线，终端侧边与顶部继续保留边距。关闭按钮使用较小的全角 `ｘ`，保持标题字重，右边缘与正文数值列对齐；ASCII 模式使用 `x`。符号周围各扩展一列、一行作为点击区域。Esc、普通左键点击面板外、继续编辑或终端上报失焦时也会关闭，不改变配置。

面板默认使用适配深浅主题的中性灰背景，避免借用消息区域的强调色。标签与数值分开着色，选中入口只提亮文字；旧宿主缺少颜色样式接口时采用终端默认背景。

## 从旧配置迁移

v5 删除旧 `views`、`collapsed` 和行列样式。首次读取有效的 v4 格式时：

1. 校验整个旧配置；无效文件保持原样。
2. 将旧文件的原始字节备份到 `<agent-dir>/extensions-data/.backups/pi-footer-composer/config-v4-<随机 ID>.json`。
3. 从当前视图提取精确 `status` 选择器，保留顺序和隐藏状态；旧 `remaining` 不再自动启用 `includeUnmapped`，避免重复摘要与内部状态挤入详情。
4. 标为“项目”“策略”“速度”的旧状态项默认隐藏；原生模式、基础文本色与边框色保留。
5. 原子写入版本 5。后续启动不重复迁移，也不读取备份作为运行配置。

旧表格的左右比例、行列位置、字段前后缀等不再参与新布局。隐藏项可在 `more.sections` 手动恢复；备份用于人工恢复原始配置。普通点击与详情切换不保存配置，模式切换会先读取最新文件，避免覆盖外部编辑。
