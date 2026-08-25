# AGENTS.md — huangrx6/pi-plugin 仓库规约

个人 pi 扩展 monorepo。四个扩展：`pi-skill-inject` / `pi-mode-switcher` / `pi-quota-status` / `pi-policy-engine`。以下是**必须遵守**的约定——每条都来自真实踩坑（标注了来源）。

## 扩展独立性（最高优先级约定）

扩展之间**完全独立、互不感知**——没有例外：

- **代码**：不得 import 另一扩展的任何模块，不得监听/依赖另一扩展注册的事件或命令。
- **测试**：不得引用另一扩展的文件；跨扩展的行为验证不写进任何扩展的测试。
- **文档**：扩展 README/DESIGN 不得链接或描述另一扩展（连“与 X 正交/配合”都不写——一旦写了，抽走一个扩展另一个就断）。职责边界只允许出现抽象表述，如“工具权限不在本扩展范围内”。
- **仓库根**：根 README 只列扩展清单（每扩展一行定位 + 链接），不写扩展间的配合说明；根 `scripts/` 不存放跨扩展测试（要验证扩展组合行为，临时在仓库外写，不进 git）。

违反例子（曾真实发生过，全部回滚）：policy-engine 的 README 写过“与 mode-switcher 正交/共存矩阵”、mode-switcher README 反向链接、根 `scripts/interop-check.mjs` 同时 import 两个扩展。

## 语言与结构

- **语言选择**：import pi 运行时类型（`@earendil-works/*`）的扩展用 TypeScript；纯逻辑、不绑 pi namespace 的包用 plain JS（`pi-policy-engine` 先例，理由见其 `SOURCES.md`）。
- **结构按规模递进**，不要一上来就分层：
  - <400 行 → 单 `index.ts`（skill-inject / mode-switcher）
  - >400 行 → 平铺多模块（quota-status 的 `adapters/format/render/state/types.ts`）
  - 带数据目录（policies/config/profiles）→ `extensions/<pkg>/index.js` 装配 + `src/core/` 纯逻辑（policy-engine）
- `src/core/` 里的模块**不得 import pi 任何东西**——纯函数，独立可测。

## Manifest 铁律（本次审查修的四个坑，全部成文化）

1. **根 `package.json` 的 `pi.extensions` 必须列全每个扩展**。新增扩展 = 建 `extensions/<name>/` 目录 + 在根 manifest 注册，缺一不可（`bin/install.sh` 靠目录自动发现，但根 manifest 漏注册 = 整库安装时该扩展静默不加载——policy-engine 曾经漏掉）。
2. **`package.json` 的 `version` 必须等于该扩展 CHANGELOG 最新条目**（policy-engine 曾停在 0.1.0 而 CHANGELOG 已到 0.11.x）。
3. **代码用了 Node 20+ API（如 `Array.prototype.toReversed`）必须声明 `engines: {"node": ">=20"}`**。
4. **`description` 必须与实际行为一致**（mode-switcher 曾描述"Four-mode auto/plan/safe/lock"，实际是三模式 ask/smart/full）。改行为时同步改 description。

## 检查与测试

- 每个扩展自带 `npm run check`（语法）与 `npm test`（self-test + smoke）。**`check` 脚本用 glob 覆盖全部源文件，不手写文件清单**——手写清单会随重构腐烂（policy-engine 曾列 6 个文件漏了 7 个）。
- **测试临时文件一律 `os.tmpdir()` + `mkdtemp`，禁止建在包根目录**（曾用 `.tmp-validate-*` 建在包根，断言失败即残留进 git status）。
- TS 扩展要进 CI 类型检查，需要自带 `tsconfig.json` + ambient `globals.d.ts` shim（pi 包不在本地 node_modules，shim 声明其模块形状）。参考实现：`extensions/pi-quota-status/`。

## Markdown

- MD013（行宽）**全仓禁用**（中文仓库 80 列硬折行破坏可读性），配置在 `.markdownlint.jsonc`，**不要**在单个文件里贴 `markdownlint-disable MD013` 膏药。
- 目录树 / ASCII 图的 fence 用 ` ```text `，不给语言会挂 MD040。
- 排除目录（`.legacy/`、node_modules）用命令行 `#` 负向语法（见 ci.yml）；config 的 `ignoreFiles` 匹配不了点目录。

## 提交

- Conventional Commits + 扩展 scope：`feat(pi-policy-engine): …` / `fix(pi-quota-status): …` / `docs: …` / `chore: …`。
- 纯 formatter 重排单独提 `chore: format drift from biome`，不与功能改动混在一个 commit。

## 已知缺口（按此路径补）

- mode-switcher / skill-inject 无类型检查基建 → 抄 quota-status 的 tsconfig + globals.d.ts 模式，CI 加对应 job。
- CI actions 用 `@v4` tag 未钉 commit SHA（沙箱无 HTTPS 出网解不了权威 SHA；有网时钉死并删本行）。
