# Design — pi-skill-inject 0.3.0

> 本文档记录 pi-skill-inject 的内部架构与关键决策，补充 README 的用户视角。
> 扩展独立性铁律：仅依赖 `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`，
> 不修改其他扩展的状态、不依赖其命令或事件。

## 核心架构

```text
输入文本                     skill 列表（pi.getCommands 派生）
   ↓                                ↓
findInlineSkills(text, skills) ← exact map + loose map
        ↓
[ParsedSkillBlock]
        ↓
pi.on("input")           拦截用户输入（同步 transform）
        ↓
pi.on("before_agent_start")  注入 inline-skill 自定义消息
        ↓
LLM 看到  <skill name=".." location="..">..</skill>
```text

## skill 发现与缓存

`collectResources(pi, cwd)` 在 `session_start` 调用：

- `pi.getCommands()` 返回所有命令
- 筛 `source === "skill"` 且 `name.startsWith("skill:")` 的 entry
- 每个 entry 的 `path` 经 `normalizePath`（realpath 防重）后入 `SkillInfo.path`
- 非 skill 命令的 name 入 `commandNamesCache`（防 skill token 撞命令）

缓存 map:

- `realpathCache`: path → realpath（去重 + 减少 syscall）
- `skillsCache`: SkillInfo[]（按 pi 加载顺序稳定）
- `commandNamesCache`: Set<string>（用于 before_agent_start 时拦截 `/mode` 等命令）

`session_start` 重置缓存（cwd 可能变）；`session_tree` 不重置（cwd 不变）。

## 加载 + 注入

**`pi.on("input", handler)`**：拦截用户输入

- 第一 token 是 `MUTATION_VERBS`-like（`/` 开头的纯命令）→ `continue`（不修改）
- 否则调 `findInlineSkills(text, skillsCache)`
- 找到新 skill（未在 `loadedSkills` 集合）→ `loadSkillBlockCached` → 加入 `pendingSkills`
- return `{action: "transform", text}`（不修改 text，仅标记）

**`pi.on("before_agent_start", handler)`**：消费 `pendingSkills`

- 构造 `customType: "inline-skill"` 自定义消息，含 `<skill>` XML 片段
- `display: true` 让 TUI 渲染 skill 卡片
- `details: { names, skills }` 让自定义 renderer 折叠/展开

## token 匹配规则（关键）

`SKILL_TOKEN_RE = /\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])(?=[\s.,;!?"')\]}]|$)/gi`

行为细节（已加锁回归测试）：

- `https://design-api` → `//` 前缀 → 跳过（URL-ish skip）
- `host:design-api` → `:` 前缀 → 跳过
- `/Design-Api` → 大小写回退命中 `design-api`（loose map）
- `/design-api /design-api` → 去重（同一 skill 只注入一次）
- 末尾的 `$` 后顾意味着 `prompt 末尾的裸 token` 也匹配

## `/loaded-skills` 命令

读取当前 session 已加载 skill 集合：

- 扫 session entries 中 `customType: "loaded-skill"` 的所有 entry
- 扫 session entries 中 `customType: "inline-skill"` 的 `details.skills`

返回 sorted list 给 `ctx.ui.notify`。

## loaded-skill stale 检测（0.x 计划）

每次 `pi.on("tool_result")`（读 SKILL.md 后）记录：

- `appendEntry("loaded-skill", { name, path, mtimeMs })`

restore 时比对 `path` 的当前 `mtimeMs`：若变化，从 loaded set 移除（视为内容已更新，下次 inline-skill 重新触发）。

## 已知边界

- **skill 名称含特殊字符**：`SKILL_TOKEN_RE` 仅匹配 `[a-z0-9-]`，skill 名带下划线
  或点的不会 inline 触发（但 `/loaded-skills` 仍能查）
- **pi 内置 slash command 优先**：`/help`、`/clear` 等仍走 pi 原生命令，
  skill 注入不触发（`commandNamesCache` 已在 before_agent_start 拦截）
- **多轮复用**：skill 一旦 `loaded`，跨 turn 不再注入（除非 mtime 变化）
- **渲染卡可折叠**：`inline-skill` 自定义消息在 TUI 显示卡片（不污染 LLM context，
  因 `display: true` 但 LLM 看到的是纯 XML skill 内容）

## 未来可考虑的增强

1. skill 优先级排序（多 skill 注入时按 dependency / importance）
2. skill 参数化（`<skill name="foo" arg="bar">`）
3. skill 版本控制（加载指定版本的 skill）
