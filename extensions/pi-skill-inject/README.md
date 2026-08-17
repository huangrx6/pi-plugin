# pi-skill-inject

pi 的**内联 skill 加载**扩展：在 prompt 里输入 `/skill-name`，把该 skill 的内容注入到**当前这一轮对话**，不切换上下文、不执行命令。斜杠 token 保留在可见的 prompt 里，方便回退/编辑之前的输入。

## 功能

### 核心能力：内联注入

```text
let's /tdd this and /review when done
```

输入包含 `/tdd`、`/review` 时：

- 这两个 token 对应的 skill 内容会在**后台加载**，随本轮 prompt 一起发送给模型；
- 模型直接拿到 skill 的完整指令，无需你手动 `/skill:name` 或让模型自己 `read`；
- 斜杠 token 仍显示在 prompt 里（不会消失），回退编辑历史输入很方便；
- 同一会话分支里已加载过的 skill **不会重复注入**（避免上下文膨胀）。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/loaded-skills` | 列出本会话已内联加载的 skill |

### 触发规则

- token 形如 `/name`，其中 `name` 为 `[a-z0-9][a-z0-9-]*`（小写字母、数字、连字符）；
- 精确匹配 skill 名优先，其次大小写不敏感 fallback（`/MY-SKILL` 能命中 `my-skill`）；
- 匹配到 URL、文件路径、`/skill:name` 命令时**不会误触发**；
- prompt 开头若是一个已注册的非 skill 命令（如 `/model`），扩展不干预。

## 安装

### 在线安装（从 GitHub）

```bash
pi install git:github.com/huangrx6/pi-skill-inject
```

安装后重启 pi，或执行 `/reload` 热加载。

### 离线安装（本地目录）

```bash
pi install /Users/huangrx6/pi-skill-inject
```

> 说明：`pi install` 支持多种来源——npm 包（`npm:...`）、git 仓库（`git:...`）、GitHub 裸地址、以及本地绝对/相对路径。安装后的包会注册到用户级 `settings.json` 的 packages 列表。

### 手动放置（无安装命令环境时）

将 `index.ts` 放入 pi 扩展的自动发现目录：

```
$HOME/.pi/agent/extensions/pi-skill-inject/index.ts
```

pi 启动时自动扫描该目录并加载。重启 pi 或 `/reload` 生效。

### 验证是否生效

```bash
pi list            # 确认包已注册（若通过 pi install 安装）
```

在 pi 会话里输入 `/loaded-skills`，能看到命令响应即加载成功。

## 实现原理

### 扩展如何被 pi 加载

pi 扩展是一个导出 `default` 工厂函数的模块。pi 启动时扫描扩展目录（三种形态：直接 `.ts` 文件、带 `index.ts` 的子目录、带 `package.json` 的包），用 **jiti** 编译并加载 TypeScript，然后调用工厂函数并传入 `ExtensionAPI`：

```typescript
export default function (pi: ExtensionAPI): void {
  // 在 factory 里向 pi 注册能力
  pi.on("input", handler)                 // 订阅事件
  pi.registerCommand("loaded-skills", …)  // 注册命令
  pi.registerMessageRenderer("inline-skill", …)  // 注册消息渲染
}
```

pi 不解析扩展的业务逻辑——扩展通过调用 `ExtensionAPI` 的方法，把回调"登记"进 pi 的运行时（事件表 / 命令表 / 渲染器表）。之后 pi 在对应时机回调这些注册的 handler。

### 事件流（一次内联注入的完整链路）

```
用户输入 "let's /tdd this"
        │
        ▼
① input 事件
   → 扩展收到原文，用 SKILL_TOKEN_RE 扫描 /token
   → 命中 skill:tdd，读取其 SKILL.md，构造注入块
   → 返回 { action: "transform", text }（原文不动，标记已处理）
        │
        ▼
② 输入不是命令，进入 agent 流程
        │
        ▼
③ before_agent_start 事件
   → 扩展返回 { message: { customType: "inline-skill", content: "<skill>…</skill>" } }
   → pi 把这条消息持久化到会话，并随本轮发给模型
        │
        ▼
④ 模型这一轮直接看到 skill 内容
        │
        ▼
⑤ TUI 渲染时，扩展的 registerMessageRenderer 把这条消息显示为
   [inline-skill] tdd (1 skills)   ← 可折叠的摘要卡片
```

### 关键设计点

| 机制 | 说明 |
| --- | --- |
| **零 monkey-patch** | 不修改 pi 内部类的原型方法，只用官方事件流（`input` → `before_agent_start`），对 pi 升级更稳健 |
| **去重注入** | 注入的消息会持久化到会话分支，`restoreLoadedSkills()` 从分支恢复已加载集合；模型通过 `read` 工具读 SKILL.md 时也会被标记（`tool_result` 事件监听）|
| **严格 token 匹配** | 正则前瞻排除 `[a-z0-9-]`、`:`、`/`，避免把 URL、路径、`/skill:name` 当作 token |
| **结构化注入** | 内容通过 `ParsedSkillBlock`（name / location / content / userMessage）传递，`content` 里带 "References are relative to <dir>"，让 skill 的相对路径引用仍然有效 |
| **性能** | skill 列表在 session 内缓存（`collectSkills` 结果缓存），不重复遍历 `pi.getCommands()` |
| **frontmatter 安全** | 只认**行首**的 `---` 为 frontmatter 结束，描述里出现 `---` 不会误截断 |

### 文件结构

```
pi-skill-inject/
├── index.ts          # 扩展入口（全部逻辑，单文件）
├── package.json      # 包元信息（声明依赖，pi 自动别名映射）
├── README.md         # 本文档
├── LICENSE           # MIT
└── .gitignore
```

## 与上游扩展的关系

本扩展是 `@tifan/pi-inline-skills` 的**完全重构**（MIT 许可），在保留"内联注入"核心体验的同时，修复了上游的全部已知问题：

| 维度 | 上游 | 本扩展 |
| --- | --- | --- |
| 侵入性 | monkey-patch `CustomEditor.prototype` | 零 monkey-patch，纯事件驱动 |
| 重复显示 | autocomplete 与 pi 原生重复 | 按 skill 名去重 |
| 匹配 | `text.replace` 遍历 + 宽松前瞻 | `matchAll` + 严格边界 |
| 性能 | 每次全量遍历命令 | session 内缓存 |
| 大小写 | map 覆盖（大小写冲突丢一个）| 精确匹配 + fallback |
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
