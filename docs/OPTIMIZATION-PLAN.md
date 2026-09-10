# 优化计划（2026-09-09 评审后）

> 本文档是仓库全 9 扩展深度评审（HEAD `705bcd4`）之后产出的完整优化路线图，按 **优先级 × 实施顺序** 排布。每个大项拆到「单 commit 可完成」的颗粒度，每个子项均给出验证标准与涉及文件。

**基线**：9 扩展 `npm run check` 通过、1413 测试全绿（policy-engine 324 / pi-todo 899 / pi-notify 54 / pi-quota-status 39 / pi-browser-test 39 / pi-auto-compact 28 / pi-footer-composer 13 / pi-mode-switcher 10 / pi-skill-inject 7）。

**评审原文**：见上方评审报告（涵盖 8 维度 × 9 扩展 + 仓库级结论 + 跨扩展耦合识别）。

---

## 总体计划

| Phase | 主题 | 预估 commit 数 | 风险等级 |
|---|---|---|---|
| **P0 准备** | 测试基线 / 脚本钩子 / 共享 shim 骨架 | 1–2 | LOW |
| **P1 结构性修复** | footer status key 协议化、globals.d.ts 单源化、policy-engine dialog 与 plan-mode 互斥 | 5–7 | **HIGH** |
| **P2 质量深化** | pi-todo 分层、auto-compact 用户指令竞态、classifier 回滚等价性、bash-risk fuzz、findInlineSkills 回归 | 8–10 | MEDIUM |
| **P3 完整性抛光** | skill stale 检测、plan-display 措辞、DESIGN.md 补全、其他文档一致 | 4–6 | LOW |
| **P4 验证与回归** | 全仓 npm test、CI 一遍、markdownlint、lens_diagnostics 全清零 | 1 | LOW |

**总预估**：20–25 commit，约 4000 行代码与测试增量，分多天推送。

每个 commit 单独发，符合 `chore:` 改写 + `feat(scope):` / `fix(scope):` 改功能的拆分规约；每个 commit 完成后跑 `npm test` + 静态检查。

---

## 提交批次（推荐顺序）

| 批次 | 内容 | 备注 |
|---|---|---|
| 1 | P0.1 baseline 脚本 → P0.2 shim 骨架 → P1.3 globals.d.ts 单源化 → P1.1 footer 协议定义（协议层不动，只定义常量 + README） | 地基 + 协议先立 |
| 2 | P1.1.6 quota 迁移 → P1.1.7 policy 迁移 → P1.1.8 mode 迁移 | publisher 切到新前缀 |
| 3 | P1.1.9 footer 移除兜底 → P1.2 plan-mode 互斥 | 收尾 footer 协议化 + 互斥 |
| 4 | P2.1 compact async → P2.2 auto-compact 用户 race → P2.6 classifier fallback → P2.7 lifecycle restore → P2.4 skill 回归 → P2.5 mode-switcher fuzz | 质量深化 |
| 5 | P2.3 pi-todo 三层拆分 | 分层 |
| 6 | P3.1 skill stale → P3.2 plan-display 措辞 → P3.3 DESIGN × 5 → P3.4 一致性脚本 → P3.5 description 巡检 | 抛光 |
| 7 | P4.1 全验证 | 收尾 |

每个批次推送前：`bash scripts/baseline.sh` + markdownlint + lens_diagnostics。

---

## P0 准备（地基）

### P0.1 全仓测试基线 + 失败快照固化

| ID | 内容 | 验证 |
|---|---|---|
| P0.1.1 | 在仓库根 `scripts/baseline.sh` 中固化全仓 baseline：依次跑所有 9 扩展 `npm test`（policy-engine 加 `npm run check`） | `bash scripts/baseline.sh` 退出码 0，输出每个扩展的 `ℹ pass N / ℹ fail 0` |
| P0.1.2 | 在脚本里加 fail-fast：任一扩展 fail 即 exit 1 | 手动让一扩展 fail，脚本立即退出 |
| P0.1.3 | 把 `scripts/baseline.sh` 加入 `package.json` 的 `scripts.test:all`（不替代各扩展自身脚本，只用于根级 CI 之外的「全部一次跑」） | `npm run test:all` 等价于 `bash scripts/baseline.sh` |
| P0.1.4 | 在每个 commit 的 CI 检查中（可在 `.github/workflows/ci.yml` 加一个 `pi-baseline` job）—— **先不动 CI，改 manual-only**，避免他人 PR 受影响 | 脚本本身可通过，文档说明 manual 触发 |

**总文件**：`scripts/baseline.sh`（新）、`package.json`（改 ~3 行）。**总行数** ~40。**commit**：`chore: 全仓 baseline 测试脚本`。

### P0.2 共享 ambient shim 骨架（为 P1.3 做准备）

| ID | 内容 | 验证 |
|---|---|---|
| P0.2.1 | 建 `extensions/_shared/pi-ambient.d.ts`（目录与命名：下划线前缀表示这是 repo 内部，不被 `bin/install.sh` 当作扩展），文件包含一行注释 + 空 declare module 占位 | 文件存在，内容是注释 + `declare module "@earendil-works/pi-coding-agent" { }` |
| P0.2.2 | 在根 `tsconfig.base.json`（新）定义 `compilerOptions`：`{ "target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":true,"esModuleInterop":true,"skipLibCheck":true }` | `npx tsc -p extensions/pi-skill-inject/tsconfig.json --noEmit`（不修 tsconfig.json 的 paths）仍然能通过 |
| P0.2.3 | 在每个 TS 扩展的 `tsconfig.json` 中加 `"extends": "../../tsconfig.base.json"`（policy-engine 是 plain JS 不动） | 每个扩展 `npm run check` 仍通过 |
| P0.2.4 | **这一步不做真正的 shim 迁移** —— 只搭架子；真实单源化在 P1.3 完成 | 仅基线测试不破 |

**总文件**：`extensions/_shared/pi-ambient.d.ts`（新）、`tsconfig.base.json`（新）、9 个 tsconfig.json 各加一行 extends。**总行数** ~50。**commit**：`chore(scaffold): 共享 ambient 骨架 + 根 tsconfig.base`（per-extension extends 是独立 commit 或随 P0.2.4 一并，推荐独立：`chore(refactor): 各 TS 扩展 tsconfig 继承根 tsconfig.base`）。

---

## P1 结构性修复（HIGH）

> 这是仓库真正「会出 bug 但你不知道」的层。每项都涉及跨扩展契约，必须 **严格保留向后兼容窗口**（老 key 仍识别一段时间，但文档主推新协议）。

### P1.1 footer-composer status key 字面量耦合

**问题**：footer-composer `sectionOf` 用 substring 兜底识别 6 个其他扩展的 status key（`mcp`/`lsp`/`mode`/`policy`/`quota`/`context`/`qos`）。**修复**：引入显式 `kind:` 前缀协议，让 footer 只信任 prefix；substring 兜底移到 `legacyRouteOf`（`@deprecated`），并在 README 显式标注。

**协议**：`setStatus("<kind>:<subkey>", text)`，`sectionOf` 只信任 `<kind>:` 前缀；`<kind>` 由 footer 定义枚举：`quota`/`usage`/`config`/`integration`/`context`/`misc`。

#### P1.1.1 ~ P1.1.5 footer 协议定义侧

| ID | 内容 | 验证 |
|---|---|---|
| P1.1.1 | **协议定义**：在 `extensions/pi-footer-composer/config.ts`（或新增 `protocol.ts`）导出 `export type StatusKind = "quota"\|"usage"\|"context"\|"integration"\|"config"\|"misc";export const STATUS_KEY_PREFIX = (kind: StatusKind) => kind + ":";` | 类型/常量存在，TypeScript 通过 |
| P1.1.2 | **`sectionOf` 收窄**：把 startsWith 改为唯一识别路径，substring 兜底放进 `legacyRouteOf(key)` 函数，在函数头加 `// @deprecated best-effort:依赖具体扩展的字面量 key 不在隔离铁律之内,新扩展必须用 STATUS_KEY_PREFIX。` | `sectionOf` 函数体只做 prefix 匹配，grep `startsWith("quota:")` 等存在 |
| P1.1.3 | **legacy path 测试**：在 `extensions/pi-footer-composer/tests/section-routing.test.ts`（新）写一组断言：每个 kind 接受 `kind:` + 拒绝无 prefix 的同字面量 | 新测试 ~20 个断言全过 |
| P1.1.4 | **文档**：在 footer-composer README 写明"`setStatus` 用户约定前缀：`quota:`/`usage:`/`context:`/`integration:`/`config:`，不要使用裸 `quota` 等字面量，那是被 deprecated 的兜底" | README 增 1 节 |
| P1.1.5 | **P1.1.6 / P1.1.7 / P1.1.8 涉及其他扩展** —— 分别独立 commit | 见下 |

**总文件**：footer-composer config/protocol 新增，新增 section-routing.test.ts，README 增节。**commit**：`feat(pi-footer-composer): 显式 status kind 前缀协议（替代字面量 substring 兜底）`。

#### P1.1.6 pi-quota-status 迁移到新 key 前缀

| ID | 内容 | 验证 |
|---|---|---|
| P1.1.6.1 | `extensions/pi-quota-status/constants.ts`：`WIDGET_KEY = "quota"` → `WIDGET_KEY = "quota:main" as const; export const LEGACY_WIDGET_KEY = "quota";` | 类型通过 |
| P1.1.6.2 | `extensions/pi-quota-status/index.ts`：`setStatus(WIDGET_KEY, ...)` 主路径不变，加 `setStatus(LEGACY_WIDGET_KEY, ...)` 在同一处 set 同一段 text（双写，过渡用） | 两个 key 都 set，grep `WIDGET_KEY\|LEGACY_WIDGET_KEY` 全到位 |
| P1.1.6.3 | `extensions/pi-quota-status/tests/adapters.test.ts` 增 1 个测试断言：当 `LEGACY_WIDGET_KEY` 被读取，`monitor.state.lastRefreshText` 也被 set 过 | 测试过 |
| P1.1.6.4 | `extensions/pi-quota-status/CHANGELOG.md`：0.3.0 条目记 "迁移到 status kind 前缀 `quota:`，保留裸 `quota` 兼容一迭代周期；1.0.0 移除兼容" | CHANGELOG 行存在 |

**commit**：`feat(pi-quota-status): status key 迁移到 kind 前缀 + 兼容过渡`。

#### P1.1.7 pi-policy-engine 迁移到新 key 前缀

| ID | 内容 | 验证 |
|---|---|---|
| P1.1.7.1 | `extensions/pi-policy-engine/extensions/policy-engine/lifecycle.js` setStatus 调用：确认 key 命名，如果有"裸 `policy`"的 set 改成 `policy:phase` | grep `setStatus("policy` 显示新格式 |
| P1.1.7.2 | `extensions/pi-policy-engine/extensions/policy-engine/commands.js`：`/policy` 命令面板内的 setStatus（若有用）同样迁移 | grep 一致 |
| P1.1.7.3 | 测试更新：`extensions/pi-policy-engine/tests/state.test.js`（或新增）验证 `policy:phase` 被识别 | 测试过 |

**commit**：`feat(pi-policy-engine): footer status key 加 kind 前缀`。

#### P1.1.8 pi-mode-switcher 迁移

| ID | 内容 | 验证 |
|---|---|---|
| P1.1.8.1 | `extensions/pi-mode-switcher/index.ts` `renderStatus(ctx)` 的 setStatus key 从 `"mode"` → `"config:mode"`（让 footer 显式归入 config section） | `setStatus("config:mode"` 出现 |
| P1.1.8.2 | `extensions/pi-mode-switcher/tests/ui.test.ts` 增断言：setStatus 被调用时 key 是 `config:mode` | 测试过 |

**commit**：`feat(pi-mode-switcher): status key 迁移到 config: 前缀`。

#### P1.1.9 footer-composer 移除 substring 兜底（最后一个 commit，等所有扩展迁移完）

| ID | 内容 | 验证 |
|---|---|---|
| P1.1.9.1 | `sectionOf` 移除 `legacyRouteOf` 的 substring 路径，只保留 prefix + 兜底到 misc | grep `k.includes`/`k ===` 不再出现在 sectionOf |
| P1.1.9.2 | 旧字面量 key 的 fallback 改为静默归入 misc（不再"误中"具体 section） | 测试覆盖 |
| P1.1.9.3 | README 标注："legacy substring 路由已移除；若 status 落进 misc，请升级 publisher 用 prefix" | README 更新 |

**commit**：`feat(pi-footer-composer): 移除 status key 字面量兜底（迁移窗口结束）`。

### P1.3 globals.d.ts 单源化

**问题**：9 个 TS 扩展各持一份 pi ambient shim，升级 pi 时 9 份同步。**修复**：把 shim 提到 `extensions/_shared/pi-ambient.d.ts`，各扩展 tsconfig `include` + `paths` 引用。

| ID | 内容 | 验证 |
|---|---|---|
| P1.3.1 | 收集 9 份 globals.d.ts 的全集，合并去重写入 `extensions/_shared/pi-ambient.d.ts`（新） | 文件存在 |
| P1.3.2 | 用脚本（一次性 `node -e "..."` 内嵌）扫描 9 份内容，把每个 method/type 至少出现一次 | grep 显示全集 |
| P1.3.3 | 各 TS 扩展的 `globals.d.ts` 删除，tsconfig.json 加 `"include": ["../../extensions/_shared/**/*.d.ts", "**/*.ts"]` | 删除文件存在，tsconfig 改对 |
| P1.3.4 | 根 `tsconfig.base.json`（P0.2.2 已建）加 `"include": ["extensions/_shared/**/*.d.ts"]` 作为全局兜底 | 根 tsconfig 通过 |
| P1.3.5 | 跑 baseline 验证所有扩展 `npm run check` 仍 0 错误 | baseline 通过 |
| P1.3.6 | README/DESIGN 更新：不再在每个扩展独立维护 globals.d.ts | 文档更新 |

**总文件**：`extensions/_shared/pi-ambient.d.ts`（新，可能 ~150 行），9 个 globals.d.ts 删除，9 个 tsconfig 改 include，README/DESIGN 更新。**commit 序列**：先单 commit `feat(refactor): globals.d.ts 单源化到 extensions/_shared/`，再补 `chore(refactor): 清理各扩展 globals.d.ts 残留引用`。

### P1.2 policy-engine 审批对话框与官方 plan-mode 互斥

**问题**：`policy-engine` 的 `offerPlanApprovalDialog` 用 `ctx.ui.select([...])` 触发 Execute/Refine/Cancel；**官方 plan-mode 示例（`examples/extensions/plan-mode/index.ts`）也用 `ctx.ui.select(["Execute the plan","Stay in plan mode","Refine the plan"])`**。如果用户同时装两者，任意"计划就绪"事件会让两个扩展都尝试弹 dialog——状态机不被任一方独占。

**修复**：policy-engine 在弹 dialog 前先探测官方 plan-mode 是否活跃——通过 `pi.getAllTools()` / `pi.getActiveTools()` 检查是否存在 plan-mode 注册的特征 tool。**没找到现成标识时，采用稳妥方案**：`offerPlanApprovalDialog` 内部序列化一次"对话框锁"，并把 dialog 内容做得**对 plan-mode 0 副作用**——Execute 走与 plan-mode 完全相同的"next user message + plan-mode-execute customType"路径，避免双 dialog 都改 phase。

| ID | 内容 | 验证 |
|---|---|---|
| P1.2.1 | **协议层探索**：查 pi 0.85 文档，确认是否有"扩展清单 API"能列出已注册 tools/commands | 找到 `pi.getAllTools()` 返回 `{name, sourceInfo, ...}`，`sourceInfo.source` 区分 builtin/sdk/extension |
| P1.2.2 | **探测函数**：在 plan-approval-dialog.js 增 `function isPlanModeActive(pi)`：扫 `pi.getAllTools()`，匹配 name 含 `plan` 且 `sourceInfo.source !== builtin && sourceInfo.source !== sdk` 的 tool | 单测覆盖：fake pi 返回 1 个 builtin + 1 个 "plan_mode" tool，断言 true；fake pi 返回空，断言 false |
| P1.2.3 | **互斥门**：`offerPlanApprovalDialog` 首行 `if (isPlanModeActive(pi)) { logger("plan-mode-active: skip policy dialog"); return; }` | 单测覆盖：fake pi with plan_mode tool → dialog 不弹 |
| P1.2.4 | **可观察性**：把"被互斥让位"作为一次 `ctx.ui.notify("计划就绪，但 plan-mode 扩展在活跃——交由它处理")` info 级别通知 | 通知触发断言 |
| P1.2.5 | **配置化**：不动 `config.planApprovalDialog`，但 README 增加"安装 plan-mode 时 policy-engine 会在 awaiting_approval 让位"说明 | README 更新 |

**总文件**：plan-approval-dialog.js 增 ~20 行，新增 tests/plan-approval-dialog.test.js 单测 ~30 行，README 增节。**commit**：`feat(pi-policy-engine): 审批对话框与官方 plan-mode 互斥`。

---

## P2 质量深化（MEDIUM）

> 不破坏契约，但提升正确性/可维护性。每项独立 commit。

### P2.1 pi-auto-compact ctx.compact 同步假设

| ID | 内容 | 验证 |
|---|---|---|
| P2.1.1 | `extensions/pi-auto-compact/continuation.ts:53` 改：对 `ctx.compact` 做 typeof 检查；若返回 thenable，改为 `await ctx.compact(...)` + 兼容 | 现有测试通过，新增 thenable ctx.compact fake 测试通过 |
| P2.1.2 | 新测试 `tests/continuation-runtime.test.ts` 增场景：fake ctx.compact 返回 `Promise.resolve({compact})`，验证 onComplete 仍被调用 | 测试过 |

**commit**：`fix(pi-auto-compact): ctx.compact 同步假设兼容异步返回`。

### P2.2 pi-auto-compact 用户指令 race 检测

| ID | 内容 | 验证 |
|---|---|---|
| P2.2.1 | `extensions/pi-auto-compact/continuation.ts` 在 `onComplete` 续写前增 `await new Promise(r => setTimeout(r, 0))` + 检查 `ctx.isIdle()`；若非 idle，放弃续写 | 单测覆盖：fake ctx.isIdle=false → 续写不发，notice status=completed 不是 resumed |
| P2.2.2 | 新测试：覆盖 "compact 完成时用户已在打字" → 状态 completed（不续写） | 测试过 |

**commit**：`fix(pi-auto-compact): 压缩完成时若有用户输入，放弃自动续写`。

### P2.3 pi-todo index.ts 1391 行分层

| ID | 内容 | 验证 |
|---|---|---|
| P2.3.1 | 抽 `extensions/pi-todo/command-wiring.ts`（新）装 `/todos` 命令 handler（从 index.ts 拆） | 文件存在，index.ts 减 ≥300 行 |
| P2.3.2 | 抽 `extensions/pi-todo/tool-wiring.ts`（新）装 `pi.registerTool` 块 | index.ts 再减 ≥150 行 |
| P2.3.3 | 抽 `extensions/pi-todo/lifecycle-wiring.ts`（新）装 `session_start`/`session_compact`/`session_tree`/`session_shutdown`/`tool_execution_end` handler | index.ts 再减 ≥200 行 |
| P2.3.4 | index.ts 保留 `< 300 行` 的 factory 装配 | `wc -l` 显示 < 300 |
| P2.3.5 | 全量测试仍通过 | baseline 通过 |

**commit 序列**：3 个独立 commit，每个对应一个文件的拆出；最后 `chore(refactor): pi-todo index.ts 缩到装配层`。

### P2.4 pi-skill-inject findInlineSkills 回归测试深化

| ID | 内容 | 验证 |
|---|---|---|
| P2.4.1 | `extensions/pi-skill-inject/tests/findInlineSkills.test.ts`（新）覆盖 9 个 case：URL-ish 跳过、case-insensitive fallback、去重、多个 token、`/skill:` 子查询、prompt-start slash、空 tokens、`//` 协议头 | ~20 个断言全过 |
| P2.4.2 | 测试工具：`token-extract.ts` 把待测输入与期望 skill 名列表参数化 | 测试运行 |

**commit**：`test(pi-skill-inject): findInlineSkills 回归覆盖深化`。

### P2.5 pi-mode-switcher bash-risk fuzz

| ID | 内容 | 验证 |
|---|---|---|
| P2.5.1 | `extensions/pi-mode-switcher/tests/bash-risk-fuzz.test.ts`（新）构造 30 个真实危险 bash 命令：`curl x \| bash`、`git push -f`、`sudo rm -rf /`、`npm publish`、`dd of=/dev/sda`、`mkfs.ext4 /dev/sdb`、`rm -rf /*`、`chmod 777 /` 等；断言 isRiskyBash 命中 | ~30 个断言全过 |
| P2.5.2 | 同时构造 20 个已知安全的 read-only 命令：`ls`、`cat file`、`head -n 100`、`grep -r foo` 等；断言不命中 | ~20 个断言 |
| P2.5.3 | 复合管道：`cmd1 && cmd2 \| cmd3`、`cmd1; cmd2` 各自的判定 | ~10 个断言 |

**commit**：`test(pi-mode-switcher): bash 风险矩阵 fuzz 覆盖`。

### P2.6 pi-policy-engine agent-classifier 回滚等价性

| ID | 内容 | 验证 |
|---|---|---|
| P2.6.1 | `extensions/pi-policy-engine/tests/classifier-fallback.test.ts`（新）构造识别失败响应（四个 failure mode：超时/解析错/结构校验失败/响应截断）；断言 `onFailure:"rules"` 路径下注入的 policy block 与 rules-routing 默认注入一致 | 4 个场景 × 5 个 phase × 5 个 rigor ≈ 100 断言 |
| P2.6.2 | 测 `onFailure:"block"`：直接断言 phase=blocked，无注入，tool_call 拦截但 plan 不可生成 | 测过 |

**commit**：`test(pi-policy-engine): classifier 失败回滚路径与 rules 等价性测试`。

### P2.7 pi-policy-engine restore() history 边界

| ID | 内容 | 验证 |
|---|---|---|
| P2.7.1 | `extensions/pi-policy-engine/tests/lifecycle-restore.test.ts`（新）：构造"切换 session 但 `state.history` 已被新会话的 history 注入"场景；验证 session_id 过滤仍然正确 | ~5 个断言 |
| P2.7.2 | 测试 "history.jsonl 在恢复时被另一个 session 写入" 的并发竞态：fake 文件系统层 race | ~3 个断言 |

**commit**：`test(pi-policy-engine): restore() history 跨会话过滤回归`。

---

## P3 完整性抛光（LOW）

### P3.1 pi-skill-inject loaded-skill stale 检测

| ID | 内容 | 验证 |
|---|---|---|
| P3.1.1 | `extensions/pi-skill-inject/index.ts`：`appendEntry(LOADED_SKILL_ENTRY_TYPE, { name, source: "tool-result", path: skill.path, mtimeMs })` | 数据结构扩展，TypeScript 通过 |
| P3.1.2 | `restoreLoadedSkills` 改为：每条 entry 读 `path`，stat 当前 mtimeMs；若 mtime 变化，从 loaded set 中移除该 skill 名字 | 新行为测试 |
| P3.1.3 | 新增 `tests/loaded-skill-stale.test.ts`：构造 mock mtime 变化 → assert loaded 集合变化 | 测试过 |
| P3.1.4 | 性能预算：`stat` 每次 restore 一次，几十个 entry 可承受 | 文件注释 + 性能估测 |

**commit**：`feat(pi-skill-inject): loaded-skill stale 检测（file mtime 比对）`。

### P3.2 pi-policy-engine plan-display 措辞修正

| ID | 内容 | 验证 |
|---|---|---|
| P3.2.1 | `extensions/pi-policy-engine/src/core/plan-display.js:32-40`：坏 JSON 时的 placeholder 文本从 `已记录,等待审批` 改为 `原块不可解析,显示折叠为提示`，并去掉 "等待审批" 字样 | 文本变更 |
| P3.2.2 | 测试 `tests/plan-display.test.js` 增断言：坏 JSON 占位不含 "等待审批" | 测试过 |

**commit**：`fix(pi-policy-engine): plan-display 坏 JSON 占位不再误导称"等待审批"`。

### P3.3 各扩展补 DESIGN.md

按规模补全 DESIGN.md（覆盖 5 个扩展：pi-mode-switcher / pi-quota-status / pi-notify / pi-skill-inject / pi-footer-composer）。**每个独立 commit**。

| ID | 扩展 | DESIGN 内容 |
|---|---|---|
| P3.3.1 | pi-mode-switcher | 三模式状态机 + bash risk matrix + 与 native permission gate 的关系 + composite safety net 取舍论证 |
| P3.3.2 | pi-quota-status | adapter 抽象 + throttle 策略 + 与 pi 的 `setStatus` 协议的关系 + error handling philosophy |
| P3.3.3 | pi-notify | OSC 协议子集选择 + multiplexer 路由矩阵 + sanitize 策略 |
| P3.3.4 | pi-skill-inject | input 钩子 + idempotent autocomplete shim + cache 失效策略 + loaded-skill stale 检测逻辑 |
| P3.3.5 | pi-footer-composer | section 协议 + setStatus prefix 规约 + 移除字面量兜底后的迁移历史 |

**commit**：`docs(<ext>): DESIGN.md`。

### P3.4 README/CHANGELOG 一致性巡检

| ID | 内容 | 验证 |
|---|---|---|
| P3.4.1 | `scripts/check-readme.sh` 验证：每个 CHANGELOG 最新条目 version = package.json version（已有相同 awk 一次跑过） | 退出码 0 |
| P3.4.2 | 同脚本验证每个 extension 的 description 字面量不超过 120 字符；超过则警告 | 不报 |
| P3.4.3 | 同脚本验证 description 中无 "TODO/FIXME" 占位文本 | grep 显示 0 |
| P3.4.4 | 把脚本加到 `package.json` 的 `scripts.check:docs` | 命令可用 |

**commit**：`chore(scripts): 文档一致性检查脚本`。

### P3.5 description 与实际行为再核

| ID | 内容 | 验证 |
|---|---|---|
| P3.5.1 | 9 个扩展的 description 与 README § "功能" 节交叉对 —— 查"description 提到但 README 未说"或反之 | 不一致处逐项列出并修 |
| P3.5.2 | 重点：pi-policy-engine description 中"versioned plan approvals"在 README 现状是否还成立（0.41.0 审批对话框已落地） | 更新 |

**commit**：`docs: 9 扩展 description 与 README 一致性巡检修正`。

---

## P4 验证与回归

### P4.1 全仓一次性验证

| ID | 内容 | 验证 |
|---|---|---|
| P4.1.1 | 跑 `bash scripts/baseline.sh` | 0 fail，所有测试 + check 全过 |
| P4.1.2 | `npx markdownlint-cli2 "**/*.md" "#**/.legacy/**" "#**/node_modules/**"` | 0 issue |
| P4.1.3 | `lens_diagnostics mode=all --paths extensions/pi-policy-engine/`（对最大扩展） | 0 blocking error |
| P4.1.4 | 复现上次"policy-engine 警告"场景：加 `"planApprovalDialog": false` 到 config.json，跑 baseline → 无 unknown-setting 诊断 | 退出码 0 |
| P4.1.5 | 在 policy-engine README 标注的"用户配置变更 → 重新加载生效"路径做一次手动真机验证记录（写到 docs/） | docs 加一节 |

**commit**：`chore: 全仓验证基线固化 + 验证报告`（或多个 commit，视期间改动）。

---

## 依赖图（关键路径）

```text
P0.1 baseline ──┬─→ 任何 commit 都要回归 │
P0.2 骨架   ──→ P1.3 globals.d.ts 单源化
                │
                └─→ P1.1 footer status 协议
                       ├─→ P1.1.6 quota                  ├─→ P1.1.7 policy
                       ├─→ P1.1.8 mode                  └─→ P1.1.9 footer 移除兜底（必须最后）

P1.2 plan-mode 互斥 ──→ 独立，不依赖 P1.1
P2.x 质量深化      ──→ 互相独立，可并行
P3.x 抛光        ──→ 互相独立，可并行
P4 验证         ──→ 必须最后
```

---

## 风险地图

| 风险 | 应对 |
|---|---|
| P1.1 footer 协议化破坏现有 footer 行为 | **强制双写兼容窗口**：P1.1.6/7/8 每个扩展保留 LEGACY 字面量 setStatus；P1.1.9 移除兜底在所有扩展迁移完成后**单独 commit**；移除前跑 baseline |
| P1.3 globals.d.ts 单源化后某扩展编译失败 | **先行建 shared/ 空 shim + tsconfig extends**，所有扩展跑 baseline，确保不改运行时；再迁移内容 |
| P1.2 探测 plan-mode 失败时 dialog 重复触发 | **保险丝**：即使探测失败，Execute 走 "sendUserMessage 规范短语"，与 plan-mode 的 "next message" 路径融合 —— phase 转移经过 `resolvePlanResponse` 单点，任一 dialog 触发都正确转移，只是视觉上 dialog 弹两次。可接受 |
| P2.3 pi-todo 分层破坏 wiring 测试 | **逐文件拆，每步跑 baseline**；测试覆盖率已经够，任何错位立刻可见 |
| P2.4 / P2.5 / P2.6 / P2.7 测试深化需要长时间运行 | **可分多 commit，每 commit 单独完成一个测试文件** |
| P3.x 抛光类工作量大但风险低 | **单 commit / 文档 commit 严格分隔** |
