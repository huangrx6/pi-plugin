# pi-skill-inject

在 pi 的 prompt 里输入 `/skill-name`，把对应 skill 的内容注入**当前这一轮对话**——不切换上下文、不执行命令、不打断思路。

## 快速开始

### 安装

```bash
pi install git:github.com/huangrx6/pi-skill-inject
```

重启 pi 或执行 `/reload` 热加载。其他安装方式见文末。

### 使用

在 prompt 里任意位置写 `/skill-name` 即可：

```text
let's /tdd this and /review when done
```

发送后：

- `/tdd`、`/review` 对应的 skill 内容会在**后台加载**，随本轮 prompt 一起发给模型；
- 模型直接拿到 skill 的完整指令，无需手动加载，也无需让模型自己 `read` SKILL.md；
- token 保留在 prompt 里，回退/编辑后重发很方便；
- 同一会话分支里已加载过的 skill **不会重复注入**，避免上下文膨胀。

### 怎么找到 skill（不用背名字）

skill 名可能很长，不必记住——按 `<Tab>` 让 pi 列出候选即可。候选内容随光标位置不同：

| 光标位置 | `<Tab>` 弹出的内容 |
| --- | --- |
| **prompt 开头**（行首） | pi 命令菜单：`/help`、`/reload` 等原生命令 + `skill:<name>` 形式的 skill 混在一起 |
| **prompt 中部**（前面已有文字） | 只列出 skill（`skill:<name>`），不含 pi 命令 |

- `/` + `<Tab>` → 列出全部；`/x` + `<Tab>` → 按 `x` 模糊过滤
- 选中后按 `<Tab>` / `<Enter>` 补全名字，回车发送即注入

> 提示：`<Tab>` 只是帮你补全名字，**不是必须的**——直接手敲完整的 `/skill-name` 一样生效。

## 行为细节

### token 规则

- token 形如 `/name`，其中 `name` 为 `[a-z0-9][a-z0-9-]*`（小写字母、数字、连字符）；
- 精确匹配优先，其次大小写不敏感 fallback（`/MY-SKILL` 能命中 `my-skill`）；
- URL、文件路径、`/skill:name` 命令**不会被误判**为 token；
- prompt 开头的非 skill 命令（如 `/model`）不会被拦截。

### 去重

同一会话分支内，已加载的 skill 不会重复注入。以下两种情况都会记为「已加载」：

- 该 skill 在本轮注入过；
- 模型通过 `read` 工具读过它的 SKILL.md。

输入 `/loaded-skills` 可查看本会话已加载的 skill 列表。

## 实现原理（面向维护者）

### 加载方式

pi 扩展是一个导出 `default` 工厂函数的模块，启动时扫描扩展目录（直接 `.ts` 文件 / 带 `index.ts` 的子目录 / 带 `package.json` 的包），用 **jiti** 编译加载后调用工厂并传入 `ExtensionAPI`：

```typescript
export default function (pi: ExtensionAPI): void {
  pi.on("input", handler)                        // 订阅事件
  pi.registerCommand("loaded-skills", …)         // 注册命令
  pi.registerMessageRenderer("inline-skill", …)  // 注册消息渲染
}
```

扩展通过 `ExtensionAPI` 的方法把回调登记进 pi 运行时（事件表 / 命令表 / 渲染器表），pi 在对应时机回调。

### 事件流（一次内联注入的完整链路）

```text
用户输入 "let's /tdd this"
        │
        ▼
① input 事件
   → 扫描 /token，命中 skill:tdd
   → 读取其 SKILL.md，构造注入块
   → 返回 { action: "transform", text }（原文不动）
        │
        ▼
② 输入不是命令，进入 agent 流程
        │
        ▼
③ before_agent_start 事件
   → 返回 { message: { customType: "inline-skill", content: "<skill>…</skill>" } }
   → pi 持久化该消息并随本轮发给模型
        │
        ▼
④ 模型这一轮直接看到 skill 内容
        │
        ▼
⑤ TUI 渲染为可折叠摘要卡片：[inline-skill] tdd (1 skills)
```

### 关键设计点

| 机制 | 说明 |
| --- | --- |
| **零 monkey-patch** | 只走官方事件流（`input` → `before_agent_start`），不修改 pi 内部类原型，升级更稳健 |
| **去重注入** | 注入消息持久化到会话分支，`restoreLoadedSkills()` 恢复已加载集合；模型 `read` 读 SKILL.md 也会被标记（`tool_result` 事件） |
| **严格 token 匹配** | 正则前瞻排除 `[a-z0-9-]`、`:`、`/`，避免把 URL、路径、`/skill:name` 当作 token |
| **结构化注入** | 内容通过 `ParsedSkillBlock`（name / location / content / userMessage）传递，`content` 带 "References are relative to `<dir>`"，保持 skill 相对路径引用有效 |
| **性能** | skill 列表在 session 内缓存，不重复遍历 `pi.getCommands()` |
| **frontmatter 安全** | 只认**行首**的 `---` 为 frontmatter 结束，描述里出现 `---` 不会误截断 |

### 文件结构

```text
pi-skill-inject/
├── index.ts          # 扩展入口（全部逻辑，单文件）
├── package.json      # 包元信息（声明依赖，pi 自动别名映射）
├── README.md         # 本文档
├── LICENSE           # MIT
└── .gitignore
```

## 安装方式补充

### 离线安装（本地目录）

```bash
pi install /Users/huangrx6/pi-skill-inject
```

> `pi install` 支持多种来源：npm 包（`npm:...`）、git 仓库（`git:...`）、GitHub 裸地址、本地绝对/相对路径。安装后注册到用户级 `settings.json` 的 packages 列表。

### 手动放置（无安装命令环境时）

将 `index.ts` 放入 pi 扩展自动发现目录：

```text
$HOME/.pi/agent/extensions/pi-skill-inject/index.ts
```

pi 启动时自动扫描加载，重启 pi 或 `/reload` 生效。

### 验证是否生效

```bash
pi list   # 确认包已注册（若通过 pi install 安装）
```

在 pi 会话里输入 `/loaded-skills`，能看到命令响应即加载成功。

## 与上游扩展的关系

本扩展是 `@tifan/pi-inline-skills` 的**完全重构**（MIT 许可），保留"内联注入"核心体验，修复了上游全部已知问题：

| 维度 | 上游 | 本扩展 |
| --- | --- | --- |
| 侵入性 | monkey-patch `CustomEditor.prototype` | 零 monkey-patch，纯事件驱动 |
| 重复显示 | autocomplete 与 pi 原生重复 | 按 skill 名去重 |
| 匹配 | `text.replace` 遍历 + 宽松前瞻 | `matchAll` + 严格边界 |
| 性能 | 每次全量遍历命令 | session 内缓存 |
| 大小写 | map 覆盖（大小写冲突丢一个） | 精确匹配 + fallback |
| 来源标签 | `[u:npm:...]` 暴露包名 | 简化为 `[u]/[p]/[t]` |
| frontmatter | 可能误截断 | 行首 `---` 才关闭 |
| 注入 | 手拼 XML | 结构化 `ParsedSkillBlock` + 转义 |

## 开发

```bash
# 克隆后本地编辑 index.ts 即可
git clone https://github.com/huangrx6/pi-skill-inject.git
```

- 依赖 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 由 pi 运行时自动别名映射到 pi 自身安装的模块，**开发时无需 `npm install`**；
- 用 `pi -e /path/to/index.ts` 可临时加载调试；
- 改完放到自动发现目录或 `pi install` 后，`/reload` 热加载。

## License

MIT © huangrx6
