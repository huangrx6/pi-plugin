# Design — pi-footer-composer 1.0.0

> 本文档记录 pi-footer-composer 的内部架构与关键决策，补充 README 的用户视角。
> 扩展独立性铁律：仅依赖 `@earendil-works/pi-coding-agent`，
> 不依赖其他扩展的命令或事件（**过去踩过的坑**：依赖 substring 识别
> 其他扩展 status key 字面量，违反 AGENTS.md 铁律）。本 1.0.0 起改为
> prefix-only 协议。

## 架构

```text
                   exports: StatusKind, statusKey
                          ↓
   pi.on("session_start")  ──→   mountFooter(ctx)
                                       ↓
                          pi.ui.setFooter(renderer)
                                       ↓
   render(width): cell[]  ←─────   footer renderer
   invalidate():  void           (闭包访问 activeCtx/
   dispose():    unsubscribe()      activeModel/activeThinking/
                                  footerMode/overlayCache)
```text

## 加载无闪烁（1.0.1 修复）

症状：启动 pi 时 footer 区先显示 pi 内置 default footer 数百毫秒，
随后被自定义 footer 替换（视觉上"跳一下"）。

根因：`pi.on("session_start")` 是异步触发，pi 在启动早期就先把
default footer 渲染了一帧。

修法（已在 export default 函数同步路径里）：

- 立刻 setFooter 一个返回空数组 `[]` 的占位 renderer
- 占位 renderer 让 pi 跳过 footer 区域显示（不渲染 default）
- session_start 触发 mountFooter 时被真 renderer 替换
- 用户视角：从「空白 → 自定义 footer」无可见闪烁

## Status Key 协议（0.9.0 → 1.0.0）

`sectionOf(key)` 只信任 `<kind>:` 前缀：

```text
quota:        → quota section
usage:        → usage section
context:      → context section
integration:  → integration section
config:       → config section
其他 key     → misc（兜底）
```text

`statusKey(kind, subkey)` 工厂函数生成符合协议 key。

**迁移窗口（0.9.0-1.0.0）**：

- `legacyRouteOf()` 曾作为 substring 兜底接受裸 key（"quota"、"mode"、"policy"）
- 1.0.0 删除 `legacyRouteOf`，未识别 key 一律归 misc
- 三个 publisher 已迁移：pi-quota-status（"quota:main"）、pi-policy-engine（"config:policy-engine"）、
  pi-mode-switcher（"config:mode"）

## /footer 命令

`/footer [compact|full|native]`：

- compact：4 行表格（路径、模型、上下文、状态）
- full：8 行（路径/模型/额度/窗口/上下文/用量/集成/状态）
- native：清空 footer，恢复 pi 内置 default
- 无参数：交互式选择器

模式持久化到 `<agent-dir>/extensions-data/pi-footer-composer/config.json`。

## 渲染

闭包访问的状态变量：

- `activeCtx`：最近一次 session_start 提供的 ctx
- `activeModel`：当前 model（model_select 时更新）
- `activeThinking`：thinking_level_select 时更新
- `requestRender`：renderer 内闭包，通过 `tui.requestRender()` 主动触发重绘

每个 status extension 通过 `ctx.ui.setStatus("kind:subkey", text)` 注册；
footer renderer 在每次 render 时读取 `footerData.getExtensionStatuses()` 拿到所有已注册
key-value pairs，按 `sectionOf(key)` 归类。

## 显示与边界

- CJK 安全折行：`displayWidth` + `wrapTerminalText` 在 `terminal.ts`
- 渲染用 pi 主题色：`theme.fg("text" / "dim" / "accent" / ...)`
- 旧 footer 默认 footer 标记无法通过 `getExtensionStatuses` 读取（public API 限制）
  → 需要完整原生 footer 时 `/footer native`
- 多 footer renderer 并存时 Pi 取最后注册的（替换语义）

## 已知边界

- **多 footer 扩展并存**：本扩展替换内置 footer；其他同类扩展并存时只显示
  最后注册的那个。这是 Pi 的设计，不是本扩展的 bug
- **status map 顺序**：`Object.entries().sort([a],[b] => a.localeCompare(b))`
  按 key 字母序——用户可能想要按时间序，但 locale-sort 更稳定可预期
- **renderer 闭包持有 ctx 引用**：session_shutdown 清空，但 session_tree 时
  闭包仍持有旧 ctx；model_select 用 requestRender 重绘触发下一帧用新 ctx

## 未来可考虑的增强

1. 自定义 status 分组（用户配置 kind → section 的非默认映射）
2. footer 主题跟随 Pi 主题切换
3. 多 renderer 合并（与其他 footer 扩展共存而非替换）
