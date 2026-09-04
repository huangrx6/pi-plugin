<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/footer-composer.svg" alt="pi-footer-composer" width="48" />
</p>

# pi-footer-composer

<p align="center"><strong>可选的终端安全 Footer：紧凑 / 完整 / 原生三档可切。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

启用后替换 Pi 原生 Footer，渲染带标签的分行视图，全程使用当前终端主题。它只消费 Pi 的公开聚合面（`ctx.ui.setStatus` 发布的状态、用量与会话信息），按 key 前缀路由到对应行——本扩展不知道也不白名单任何其他扩展的名字，任何调用 `setStatus` 的来源都会自动出现在表里。`/footer native` 随时无损恢复 Pi 原生 Footer。

## 入口与操作

| 入口 | 行为 |
| --- | --- |
| `/footer` | 打开视图选择器；取消静默返回 |
| `/footer compact` | 三行紧凑视图（默认）：环境、模型与套餐、上下文与配置状态 |
| `/footer full` | 五行完整诊断视图 |
| `/footer native` | 立即恢复 Pi 原生 Footer，无需卸载 |

## 展示

紧凑模式只保留日常关心的三行，完整计量与集成诊断不进主视图：

```text
环境： ~/project (main)
模型： (provider) model-id │ 套餐 5h 63%
状态： 50%/128k │ 权限 smart │ 策略 standard
```

完整模式保持五行诊断视图：每行一个暗色标签，单元格以 `│` 相连，超宽行按终端显示宽度在标签下方折行：

```text
环境： ~/project (main)
模型： (provider) model-id │ ⚡ 套餐 5h:4%(4h50m) 周:0%(70h21m)
资源： ↑1.2k ↓890 R340 CH45% $0.012 12%/128k │ ◎ ctx 6%
集成： MCP: 3 servers enabled │ LSP Inactive
配置： 权限 smart │ 策略 standard/executing
```

## 状态路由约定

扩展通过 `ctx.ui.setStatus(...)` 的 key 前缀选择落点：

| Key 形态 | 落点 |
| --- | --- |
| `quota:<name>` | 模型行（模型单元格之后） |
| `usage:<name>` / `context:<name>` | 资源行 |
| `integration:<name>` | 集成行 |
| `config:<name>` | 配置行 |
| 其他 | 配置行兜底——任何状态都不会被静默丢弃 |

无前缀的 key 由保守的关键字回退路由（含 `mcp` / `lsp` → 集成行，含 `mode` / `policy` → 配置行，含 `quota` → 模型行，含 `context` / `qos` → 资源行）。

## 安全与宽度

- 上游状态中的 ANSI / OSC / DCS 序列与双向控制字符先剥离，再用当前主题着色——发布状态的扩展不能向终端注入控制序列
- 文本按字素显示宽度计量，中文、组合字符与 emoji 不会被截成半个；极窄终端下标签保持在可用宽度内
- v0.3.2 修复过一个真实冻结 bug：带色单元格超宽时截断循环不终止，窄终端会挂死渲染器——现在有挂死前必失败的回归测试钉住

## 与原生 Footer 的差异

原生 Footer 中的内部标记（`(sub)` 订阅位、`xp` 实验位、自动压缩开关）扩展读不到，因此不渲染。需要这些标记时用 `/footer native`。

## 安装

```bash
pi install git:github.com/huangrx6/pi-plugin
```

重启 Pi 或执行 `/reload`。

## 已知限制

- Footer 独占：`setFooter` 是替换语义，两个 Footer 渲染器会互相覆盖；`/footer native` 在当前进程内禁用本渲染器
- 用量统计在 `turn_end` 刷新；分支切换即时刷新

## 开发

```bash
cd extensions/pi-footer-composer
npm run check      # tsc --noEmit
npm test           # 布局 oracle + 交互（compact/full/native、净化）
```

<details>
<summary>文件结构</summary>

```text
pi-footer-composer/
├── index.ts          # 事件接线 + 状态收集 + 渲染
├── layout.ts         # 宽度工具 + renderTable（贪心折行、多行单元格）
├── tests/            # layout / ui 测试
├── globals.d.ts      # Pi 运行时类型 ambient shim
├── tsconfig.json
├── package.json
├── CHANGELOG.md
├── README.md
└── LICENSE
```

</details>

## License

MIT © huangrx6
