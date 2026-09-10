# Changelog

## 4.0.0 - 2026-09-10

- 删除旧 `full` 模式，新增三行、无竖线和单元格框的 `overview` 信息带。
- 每个视图可独立配置 `renderer`、`showLabels` 和 `style` 覆盖；顺序、位置与内容继续完全由 `config.json` 决定。
- 紧凑默认视图补齐累计输入、输出、缓存读写与费用，并用 `↑`、`↓`、`读`、`写`、`◎` 缩短重复中文前缀。
- 新增信息带响应式渲染与测试；窄终端自动单列，长状态继续遵循折行、省略和最大行数配置。

## 3.0.0 - 2026-09-10

- 外部状态改为 `{ "status": "原始 key" }` 精确选择，直接读取 Pi 状态集合中的对应值。
- `remaining` 自动收纳所有未显式配置的状态；把 key 配进任意单元格即可将其从兜底位置移走。
- 删除状态类别、key 前缀协议、`group:*`、`statusRoutes`、`statusKey` 及全部路由实现和测试。
- 默认布局不预设任何第三方状态名称或分类，任意发布者都可直接接入。

## 2.0.0 - 2026-09-10

- `config.json` 现在定义视图、行序、左右位置、标签、字段顺序、状态选择、列宽、间距、边框、颜色与溢出策略。
- 新增内建字段、`status:<key>`、`group:<kind>` 与 `remaining` 选择器；精确状态不会被类别选择重复消费。
- 新增 `/footer reload`，校验成功后原子应用；切换模式前重新读取磁盘配置。
- 首次启动自动生成完整默认配置；发布 Draft 2020-12 JSON Schema 和可复制示例。
- 删除 1.x 的固定布局与独立状态位置映射，数据采集、配置编排和表格渲染改为独立纯逻辑模块。

## 1.2.0 - 2026-09-10

- 紧凑视图改为左右两块 label + 内容表格，加入每行之间的边框；两侧外边框保持开放。
- 左右行高同步，长字段和多行状态在格内续行，不省略后续 Token 或诊断详情。
- 所有标签和内容统一使用 muted 灰色，边框使用 dim，不额外突出模型或上下文数值。
- 新增 statusCells：通过用户配置把任意状态 key 放到指定标签和左右列，完整视图仍按原类别展示。
- 小于 72 列时退为单列分类表，避免半格过窄造成大量碎行。

## 1.1.1 - 2026-09-10

- 紧凑布局改为连续分类行，撤下三列分块，减少跨区域寻找信息。
- 统一两字标签、左对齐正文、全宽上下边线；去掉空白分区，不加行间横线或左右外边框。
- 窄屏按完整字段在所属行内换行，保留状态、集成与上下文提示。

## 1.1.0 - 2026-09-10

- 紧凑视图改为三列固定语义分组，仅保留上下边线；窄窗口纵向排列，长文本按列折行。
- 正文与次要信息分层，紧凑模式保留宿主上下文告警色。
- 新增用户 statusRoutes 精确配置映射，模式切换保留映射；不内置发布者别名。
- 紧凑视图保留额外上下文和集成状态；完整模式删除重复上下文行。
- 路由测试直接使用生产函数，补充宽度、状态保留与配置测试。

## 1.0.1 - 2026-09-10

### 紧凑 / 完整视图均拆出“上下文”行，状态行不再爆长

两个视图的原“状态”行装 5 类内容（contextCell + cacheHitCells +
sections.context + sections.config + sections.misc）；启用多个 publisher
后实际产出“上下文 6.6% / 1.0M 命中 99.5% 权限 full policy:auto
↑1.3k ↓37 MCP: 4 servers enabled LSP Inactive”，窄终端合并后压成一长串，
状态行变成“信息垃圾场”。

拆出独立“上下文”行，只装 context 语义族（上下文百分比 + 缓存命中率），
“状态”行收窄为 config / misc 兑底。紧凑视图从 3 行增到 4 行，完整视图从
7 行增到 8 行（路径 / 模型 / 额度 / 窗口 / 上下文 / 用量 / 集成 / 状态）。
副效果：labelWidth 从 4 升到 6（“上下文” = 3 中文字符 = 6 列），所有标签
│前的填充从 1 空格增到 3 空格。

- index.ts：紧凑模式从 3 行扩为 4 行，与完整模式同结构。
- README.md / DESIGN.md：紧凑视图从“三行”改为“四行”，完整视图从
  “七行”改为“八行”，状态归类表新增“上下文组”列。
- tests/ui.test.ts：compact.length 7→9，分隔线前缀从 6 个 ─ 增到 8 个；
  状态行 regex 不再断言上下文/命中（它们现在在上下文行）。
- 验证：footer-composer 23/23，baseline 9 扩展 1510 测试全过。

## 1.0.0 - 2026-09-10

### Status key 协议兑底路由移除（迁移窗口收尾）

- sectionOf 只信任 kind: 前缀；未识别的 key 一律归 misc。
  0.9.0-1.0.0 过渡期的 legacyRouteOf（依赖裸 key "quota" / "mode" /
  "policy" / "context" / substring 兑底到具体 section）已删除。
  pi-mode-switcher（"mode"→"config:mode"）、pi-policy-engine
  （"policy-engine"→"config:policy-engine"、lifecycle 的
  "policy:phase"→"config:policy.phase"）、pi-quota-status
  （"quota"→"quota:main" + LEGACY_WIDGET_KEY="quota" 双写）
  三个 publisher 已在迁移窗口完成。
- 1.0.0 后，未使用 kind: 前缀的 status 跳进 misc。这是 publisher
  的明确信号：升级到 statusKey("kind","subkey") 或显式
  setStatus("kind:subkey",...)。
- tests/section-routing.test.ts:5 个 legacy 兑底断言反向更新为
  预期 "misc"；保留对“升级信号”的明确测试。

## 0.9.0 - 2026-09-06

- Make the compact three-row table the default when no user configuration exists.
- Persist every `/footer` mode selection to `extensions-data/pi-footer-composer/config.json` and restore it on the next session or reload.
- Validate configuration strictly, fall back to compact mode with a visible warning when invalid, and publish `config.ts` with the package.

## 0.8.1 - 2026-09-05

- Show the latest assistant-message cache hit rate immediately after context usage in compact mode.
- Reuse the full view's cache-hit calculation and continue hiding cumulative token, cache-volume, cost and integration details.

## 0.8.0 - 2026-09-05

- Apply the same open-sided category table to compact view, with fixed path, model and status rows.
- Keep model identity, provider, thinking level and quota together; keep context and configuration statuses together.
- Retain compact filtering: accumulated usage and integration statuses remain hidden.
- Remove the superseded loose-row renderer and its compatibility-only tests; both custom views now share one layout path.

## 0.7.0 - 2026-09-05

- Group related fields into seven fixed category rows instead of filling individual boxes across columns.
- Remove left and right outer borders; keep horizontal rules and one aligned category divider.
- Wrap fields within their category, keeping short fields intact and showing each category label once. Preserve muted text and dim separators.

## 0.6.0 - 2026-09-05

- Replace the full view's loose rows with a bordered table: one field per cell, shared column widths, aligned intersections and padded final rows.
- Adapt from one to four columns as terminal width increases; wrap long paths and statuses inside cells using grapheme display widths.
- Use muted gray for all full-view text and dim borders, removing differences in brightness and font weight. Preserve status wording and values.
- Cover responsive borders, multiline content, terminal-control sanitization and full/compact/native switching.

## 0.5.1 - 2026-09-05

- Unify normal content color and font weight; use whitespace between fields and readable muted labels.
- Separate model identity, quota, current context and accumulated usage into short rows; keep full view as the default and hide empty groups.
- Remove leading decorative status icons and omit only redundant pure context percentages matching host usage. Preserve warnings and descriptive statuses.

## 0.5.0 - 2026-09-05

- Default to full view on load; keep compact and native views available in the single-level selector.
- Use quiet labels, soft dot separators, an accent model name and readable cache/context labels. Keep wrapped content aligned and empty groups hidden.
- Include published `usage:` statuses in full view and put current context occupancy before accumulated usage.
- Fix unlabelled rows exceeding their width by an extra leading space; cover full/compact/native switching and narrow widths.

## 0.4.0 - 2026-09-04

- Default to a three-row compact view: environment, model with quota, then context and configuration status. Full resource and integration detail remains available with `/footer full`.
- Add `/footer compact|full|native`; native mode immediately restores Pi's built-in footer, and cancelling the selector stays silent.
- Strip CSI, OSC, DCS and control bytes from paths, model metadata and published statuses before applying the current terminal theme.
- Keep labels within the available width on extremely narrow terminals, including emoji presentation sequences in display-width measurement.
- Add interaction coverage for compact/full/native switching and terminal-control sanitization; publish from an explicit package file allowlist.

## 0.3.2 - 2026-09-04

### Fix: `truncateToWidth` infinite loop on ANSI-colored wide cells

The inner escape-scan regex was built without the `g` flag, so `exec`
kept returning the FIRST escape forever. Any theme-colored cell wider
than its row budget — the footer's normal case: usage stats, context
percentage, extension statuses (e.g. quota bars) are all colored —
looped forever and froze the renderer on narrow terminals. One-flag
fix (`new RegExp(ANSI_PATTERN.source, "g")`) plus a regression test
that previously hung indefinitely.

### Local dev parity

- `npm run check` (`tsc --noEmit`) and `npm test` (`tsx --test
  tests/*.test.ts`) scripts added, with typescript/tsx/@types/node
  devDependencies and a committed lockfile — same gates CI already
  runs via `npx`.
- `tests/layout.test.ts` (9 cases): visibleWidth (ASCII / ANSI /
  CJK), truncateToWidth (short / exact / over-wide ASCII / CJK grapheme
  boundary / ANSI-preserving), makeCell.

## 0.3.1 - 2026-08-27

- Back to five rows by request: subscription quotas merge into the 模型 row (`│`-separated) and context-governance statuses merge into the 资源 row, so the footer regains its compact single-column form while keeping the generic quota:/context: routing. 集成 now precedes 配置.

## 0.3.0 - 2026-08-27

- Seven-row layout: subscription quotas move to their own `用量：` row, context-governance statuses get a `压缩：` row, `配置：` now precedes `集成：`, and the resources row returns to pure token/cache/cost/occupancy cells. New routing: `quota:*` (and the unprefixed `quota` key) → 用量, `context:*` (and `context`/`qos` keywords) → 压缩, `usage:*` stays resources. Semantics improve: the subscription percentage and the two context percentages (raw occupancy vs effective-budget pressure) are no longer crammed into one row.

## 0.2.1 - 2026-08-27

- Support multi-line status cells: a status whose text contains `\n` now renders one sub-line per display row (indented under the row label) instead of being flattened to a single line. `sanitize` keeps intentional newlines while still normalizing every other kind of whitespace and dropping empty lines. Publishers opt into stacked output by simply including `\n` — the renderer stays content-agnostic.

## 0.2.0 - 2026-08-27

- Five labelled rows (环境 / 模型 / 资源 / 集成 / 配置) with `usage:` / `integration:` / `config:` key-prefix routing and a misc fallback.
