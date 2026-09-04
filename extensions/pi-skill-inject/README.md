<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/skill-inject.svg" alt="pi-skill-inject" width="48" />
</p>

# pi-skill-inject

<p align="center"><strong>在提示词中直接引用技能，内容随本轮一起发送。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

在输入里写下 `/skill-name`，对应技能的 `SKILL.md` 会被加载并随同一轮发送给模型——没有额外往返，也不需要模型先去 `read` 文件。加载完成后，对话中出现一条紧凑的 `◆ 技能已加载` 活动记录，展开可查看本轮实际使用的技能名称与来源路径。

## 入口与操作

| 入口 | 行为 |
| --- | --- |
| 提示词中的 `/<skill-name>` | 解析并注入该技能内容，同轮生效 |
| `<Tab>`（在 `/` 或任意前缀后） | 从可用技能列表自动补全 |
| `/loaded-skills` | 以中文竖列查看当前分支已加载的技能；空态保持简洁 |

## 工作方式

扩展监听公开事件 `input` 与 `before_agent_start`：扫描提示词中的 `/<name>` 标记，解析为技能路径，把面向用户的文本替换为技能内容。模型在第一轮就拿到完整指令。

- **零侵入** — 只使用公开事件，不做原型修改；Pi 导入为类型导入
- **标记边界严格** — 正则锚定 `[a-z0-9][a-z0-9-]*` 且要求空白、标点或输入结尾；URL、路径和 `skill:name` 命令不会被误判
- **按分支去重** — 本轮注入过、或模型已 `read` 过其 `SKILL.md` 的技能都会写入分支墓碑，重载或恢复会话后不再重复注入
- **frontmatter 安全** — 只识别行首 `---` 作为分隔符，描述内的 `---` 不会破坏解析
- **终端安全** — 技能描述、路径与加载错误先清理控制序列、再按显示宽度截断后才进入界面

### 标记规则

| 输入 | 结果 |
| --- | --- |
| 提示词正文中的 `/skill-name` | 注入技能 `skill-name` |
| `/SKILL-NAME` | 先精确匹配；无精确项时大小写不敏感回退 |
| `/skill:name` | 视为 Pi 命令，不注入 |
| `https://example.com/foo` | 边界规则排除，不当作标记 |
| 行首的 `/model` | 原样传递，不拦截 |

## 使用示例

```text
用 /tdd 的方式做，完成后 /review 一遍
```

两个技能同时加载进本轮提示词，模型立即按其指令工作。对话中出现：

```text
◆ 技能已加载 · 2 个（展开查看名称与路径）
```

## 安装

```bash
pi install git:github.com/huangrx6/pi-plugin
```

重启 Pi 或执行 `/reload`。零运行时依赖、零配置。单会话试用：`pi -e <repo>/extensions/pi-skill-inject`。

## 开发

```bash
cd extensions/pi-skill-inject
npm install        # 仅 devDependencies（tsc / tsx）
npm run check      # tsc --noEmit
npm test           # 标记边界与加载解析回归
```

编辑 `index.ts` 后用 `/reload` 生效。

<details>
<summary>文件结构</summary>

```text
pi-skill-inject/
├── index.ts          # 发现、注入、渲染与命令接线
├── display.ts        # 终端安全文本与已加载列表格式化
├── tests/            # 标记边界 / 解析回归
├── globals.d.ts      # Pi 运行时类型 ambient shim
├── tsconfig.json
├── package.json
├── README.md
└── LICENSE
```

</details>

## License

MIT © huangrx6
