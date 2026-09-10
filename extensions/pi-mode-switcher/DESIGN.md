# Design — pi-mode-switcher 0.3.0

> 本文档记录 pi-mode-switcher 的内部架构与关键决策，补充 README 的用户视角。
> 扩展独立性铁律：仅依赖 `@earendil-works/pi-coding-agent` + Node.js 内置，
> 不与其他扩展耦合，不修改任何共享状态机。

## 三模式状态机

```text
            /footer ask        /footer smart       /footer full
   ──────────────────────────────────────────────────────────
  ask    │  ask               ask → smart          ask → full
  smart  │  smart → ask       smart                smart → full
  full   │  full → ask        full → smart         full
```text

每个 `pi.on("tool_call")` handler 触发 `checkPermission(mode, toolName, input, confirm)`:

- `ask`: 任何写操作或网络/未知工具 → 弹 `ctx.ui.confirm`;已知的读类工具(`read`/`ls`/`grep`/`find`/`glob`/读类 bash)直通。
- `smart`: 仅检测到 risky 操作时弹 confirm;其他自动批准。
- `full`: 无确认,所有操作通过。

切换通过 `/mode [ask|smart|full]` 或 `/mode` 交互式选择器;持久化到
`~/.pi/agent/extensions-data/pi-mode-switcher/config.json`。

## bash 风险检测(composite-aware)

`isRiskyBash` / `isWriteBash` 关键:把命令按 `&&` `||` `;` `|` `\n` 切分后,**任意 segment 命中 risky / write 规则就判该复合命令 risky / write**。

白名单/read-only 复合命令例外:`cat a && cat b`、`git status && git log`
当且仅当**所有 segment 都 provably read-only**(前缀匹配 `READONLY_SEGS` 且不含
`HIDDEN_MUTATORS`)才直通。

设计取舍:**under-decomposition 优先于 over-decomposition**(会问但不漏 ask):

- `$(rm -rf /)` 切分后第一段是 `echo`,但 substitute body 是 `rm -rf /`,
  仍命中 write + risky
- `find . | xargs rm` 第一个 segment `find` 是读类,但 `xargs rm` 命中
  write 规则

## 失败模式与提示

- `ask` 模式 + `ctx.ui.confirm` 不存在(非交互式宿主 / RPC 模式)→ 静默拒绝
- 用户取消 confirm → 拒绝并返回 "用户拒绝了此操作"
- 配置损坏 → `loadPersistedMode` catch 失败,回退到默认 `smart`,notify 警告

## 持久化与状态恢复

`modeConfigPaths()` 与 `loadPersistedMode()` / `persistMode()` 三函数封装路径:

- 默认 `<agent-dir>/extensions-data/pi-mode-switcher/config.json`
- `PI_CODING_AGENT_DIR` 覆盖路径解析(参考 policy-engine 的 PI_CODING_AGENT_DIR 处理)

每次 `session_start` 读 config 恢复 mode,不依赖 pi 的 session store。

## 已知边界

- **风险检测的黑名单局限**:`npm publish` / `pip install --user` 等不在
  risky 黑名单(走 `ask` 模式 segWriteBash 路径);若需要提升为 risky,见
  未来增强任务。
- **不阻止`:pi 内置 permission 系统**:本扩展与 pi 的内置 permission gate 并存。
  `ask` 模式下本扩展会先弹 confirm,内置 gate 也会弹;用户可能弹两个确认。
  这是独立性铁律的代价,内部需要权衡时再合并。
- **status key 迁移**(0.9.0 → 1.0.0):`"mode"` → `"config:mode"`,见
  pi-footer-composer 协议 README。

## 未来可考虑的增强

1. 把 bash risk 矩阵搬到外部 JSON,允许用户自定义黑名单
2. 提供 `/mode test` 子命令做 dry-run,展示哪些命令会被弹 confirm
3. 与 pi 内置 permission 系统集成(互让位)而非并行弹窗
