# pi-mode-switcher

pi 的**三级批准控制**扩展（类似 Claude Code 的权限级别）。**纯 pi 原生实现**——通过 `tool_call` 事件拦截工具调用 + `ctx.ui.confirm()` 弹框询问，零第三方依赖。

## 三种模式

| 模式 | 命令 | 行为 |
| --- | --- | --- |
| **🔵 请求批准** | `/mode ask` | 编辑外部文件和使用互联网时**始终弹框询问** |
| **🟡 帮我批准** | `/mode smart` | 自动批准一切，**仅对检测到的风险操作**弹框询问 |
| **🔴 完全访问** | `/mode full` | 不需要你批准任何请求，全部自动通过 |

默认模式：`smart`（帮我批准）。

## 效果

当前模式显示在 **footer 状态行**（和 MCP/LSP 等扩展状态一起，按 key 排序），`◈` 作为视觉分隔：

```text
🔌 MCP: 3 servers enabled ◈ mode:请求批准 LSP Inactive
```

- **`mode:请求批准`** 青色、**`mode:帮我批准`** 黄色、**`mode:完全访问`** 红色
- `/mode` 弹**交互选择器**（像 `/model` 一样，含中文说明，方向键选择回车确认）
- `/mode ask` / `/mode smart` / `/mode full` 直接切换
- 模式**持久化**（`~/.pi/agent/mode-switcher.json`），重启 pi 保持
- 拒绝操作时模型会看到"用户拒绝了此操作"并自我修正

## 安装

```bash
pi install git:github.com/huangrx6/pi-mode-switcher
```

重启 pi 或 `/reload` 生效。**无需任何前置依赖、无需任何额外配置**。

## 三种模式行为对比

| 工具调用 | 🔵 请求批准 | 🟡 帮我批准 | 🔴 完全访问 |
| --- | --- | --- | --- |
| `read` / `ls` / `grep` / `find` | ✅ 自动过 | ✅ 自动过 | ✅ 自动过 |
| 只读 bash（`ls`、`cat`、`git status`） | ✅ 自动过 | ✅ 自动过 | ✅ 自动过 |
| `write` / `edit` 等写文件 | 🗣️ 弹框问 | ✅ 自动过 | ✅ 自动过 |
| 联网（`fetch_content` / `web_search` / `curl`） | 🗣️ 弹框问 | ✅ 自动过 | ✅ 自动过 |
| MCP 工具 / 未知工具 | 🗣️ 弹框问 | ✅ 自动过 | ✅ 自动过 |
| 写 bash（`git push`、`rm`、`mkdir`、`tee`） | 🗣️ 弹框问 | ✅ 自动过 | ✅ 自动过 |
| **危险操作**（`rm -rf`、`sudo`、`mkfs`、`git push --force`） | 🗣️ 弹框问 | 🗣️ 弹框问 | ✅ 自动过 |

🗣️ = 弹确认框，你点 **Yes/No** 决定放行或拦截。

## 模式行为细节

### 只读白名单（所有模式都放行，不询问）

- 工具：`read` / `ls` / `grep` / `find` / `glob`
- bash：无重定向/无写命令的读操作（`ls`、`cat`、`head`、`git status` 等）

### 写工具（请求批准模式下弹框）

`write` / `edit` / `apply_patch` / `multi_edit` / `create` / `delete` / `rename` / `move` / `append`

### 写 bash（启发式判断，请求批准模式下弹框）

- 文件操作：`rm`、`mv`、`cp`、`mkdir`、`touch`、`chmod`、`chown`、`dd`、`ln`、`truncate`
- 重定向：`echo hi > file`、`>> file`（`> /dev/null` 除外）
- 管道写入：`tee`、`sed -i`
- git 变更：`git commit/push/reset/rebase/merge/checkout/restore/clean/stash/tag/branch -d/-D`
- 包管理：`npm/yarn/pnpm/pip/poetry/cargo/go/brew/apt install/add/remove/publish`
- 网络：`curl`、`wget`、`ssh`、`scp`、`rsync`、`nc`、`nmap`

### 危险 bash（帮我批准模式下弹框）

- `rm -r/-f/--recursive/--force`（递归/强制删除）
- `mkfs`、`fdisk`、`parted`、`dd of=`
- `git reset --hard`、`git clean -f`、`git push --force`
- `sudo`（提权）

> ⚠️ 这些是**尽力而为的正则启发式**。复杂命令（`&&` 组合、`$(...)` 命令替换、别名）可能漏判。识别不了的按"写"处理（更安全）。

## 实现原理

### 核心机制：pi 原生 `tool_call` 事件拦截 + confirm 弹框

pi 扩展 API 提供 `tool_call` 事件——在**任何工具执行前**触发，且**可以异步拦截**（handler 是 async，可以 await 用户交互）：

```typescript
pi.on("tool_call", async (event, ctx) => {
  const reason = await checkPermission(currentMode, event.toolName, event.input, confirm);
  if (reason) {
    return { block: true, reason, terminate: false };  // 拦截
  }
  return undefined;  // 放行
});
```

- 返回 `{ block: true, reason }` 阻止工具执行，reason 传给模型（模型看到"用户拒绝了此操作"并自我修正）
- 返回 `undefined` 放行
- **需要询问时**用 `ctx.ui.confirm(title, message)` 弹确认框，用户 Yes/No 决定

### 决策链：checkPermission()

每次工具调用进入 `checkPermission(mode, toolName, input, confirm)`：

```text
只读白名单 (read/ls/grep/find/glob + 只读 bash) → 永远放行
        ↓
mode === "full"  → 全部放行，不询问
        ↓
mode === "ask"   → 只读 → 放行；其余全部（写/联网/MCP/未知）→ confirm 弹框
        ↓
mode === "smart" → 危险 bash（rm -rf/sudo/...）→ confirm 弹框；其余全部放行
```

### bash 启发式：isWriteBash() / isRiskyBash()

**isWriteBash**（判断是否是写/联网操作）：

```typescript
function isWriteBash(cmd: string): boolean {
  const c = cmd.trim();
  if (/^(rm|mv|cp|mkdir|touch|chmod|chown|dd|ln|truncate)\b/.test(c)) return true;  // 文件操作
  if (/[>»]/.test(c) && !/[>»]\s*\/dev\/null/.test(c)) return true;  // 重定向写文件
  if (/\b(tee|sed\s+-i)\b/.test(c)) return true;  // 管道写入
  if (/^git\s+(commit|push|reset|rebase|merge|checkout|restore|clean|stash|tag|branch\s+-[dD])\b/.test(c)) return true;  // git 变更
  if (/^(npm|yarn|pnpm|pip|pip3|poetry|cargo|go|brew|apt|apt-get|yum|dnf)\s+(install|add|remove|uninstall|publish|update|upgrade)\b/.test(c)) return true;  // 包管理
  if (/^(curl|wget|ssh|scp|rsync|nc|nmap)\b/.test(c)) return true;  // 网络访问
  return false;
}
```

**isRiskyBash**（判断是否危险/不可逆）：

```typescript
function isRiskyBash(cmd: string): boolean {
  if (/^rm\b.*(-r|-f|--recursive|--force)/.test(c)) return true;  // rm 递归/强制
  if (/^rm\b.*(\/|\.\*)/.test(c)) return true;                    // rm 危险路径
  if (/^(mkfs|fdisk|parted|dd\s+of=)\b/.test(c)) return true;     // 磁盘操作
  if (/^git\s+(reset\s+--hard|clean\s+-f|push\s+--force)\b/.test(c)) return true;  // git 破坏性
  if (/\bsudo\b/.test(c)) return true;                            // 提权
  return false;
}
```

### 模式状态与持久化

```typescript
let currentMode: Mode = loadPersistedMode();  // 启动时读上次模式

function loadPersistedMode(): Mode {
  // 读 ~/.pi/agent/mode-switcher.json，无效则回退 "smart"
}

function persistMode(mode: Mode): void {
  // 写 ~/.pi/agent/mode-switcher.json，重启保持
}
```

`/mode` 命令切换时更新 `currentMode` + 持久化 + 刷新 footer 状态。

### /mode 交互选择器

无参数 `/mode` 弹**选择器**（pi 内置 `ctx.ui.select`，像 `/model` 一样）：

```text
选择权限模式（当前: 帮我批准）
  ask   — 请求批准：编辑外部文件和使用互联网时始终询问
  smart — 帮我批准：仅对检测到的风险操作请求批准
  full  — 完全访问：不需要我批准任何请求
```

> ⚠️ 注意：`ctx.ui.select()` 返回的是**选中的选项文本**（不是索引），所以从返回文本中提取模式 key（`String(choice).split(" ")[0]`）再匹配。

### Footer 显示

用 `ctx.ui.setStatus(key, text)` 写入 footer 状态行（**不是** widget）：

```typescript
function buildModeText(): string {
  const label = MODE_LABELS[currentMode];
  const color = MODE_COLOR[currentMode];
  return `${color}◈ mode:${label}${C.reset}`;
}

function renderStatus(ctx: UiCtx): void {
  ctx.ui.setStatus("mode", buildModeText());
}
```

- 所有扩展的 `setStatus` 状态会在 footer 状态行按 **key 字母序** 排列（`localeCompare`）；
- key `"mode"` 让它排在 MCP/LSP 之后、quota 之前；
- `◈` 前缀作为与其他状态项的**视觉分隔**；
- 想调整位置改 key：如 `"amode"`（排最前）或 `"0-mode"`；
- 文本简短：`◈ mode:请求批准`（带 ANSI 颜色）。

### 完整事件流

```text
启动
  ├─ loadPersistedMode() → 恢复上次模式
  └─ session_start → setStatus("mode", "◈ mode:X") 显示当前模式

每次工具调用
  └─ tool_call → checkPermission(mode, toolName, input)
       ├─ 需要询问 → ctx.ui.confirm() 弹框
       │    ├─ Yes → 放行
       │    └─ No  → { block: true, reason: "用户拒绝了此操作" }
       ├─ 危险(smart) → confirm 弹框（同上）
       └─ 其余 → undefined 放行

/mode（用户切换）
  ├─ 无参数 → ctx.ui.select() 弹选择器 → 选中 → 切换
  ├─ /mode ask|smart|full → 直接切换
  ├─ persistMode(mode) → 写入磁盘
  └─ setStatus("mode", "◈ mode:X") → footer 更新
```

## 与 pi-policy-engine 共用

两个扩展都在 `tool_call` 上拦截，实测可安全共存：拦截语义是 OR 组合取更严者，本扩展先注册先执行，任何一方 block 即短路。完整 8 场景矩阵和推荐搭配见 [pi-policy-engine README](../pi-policy-engine/README.md#与-agentsmd--skill--pi-mode-switcher-的边界)。唯一已知摩擦：ask 模式下 strict 计划已批准后仍会逐文件弹框（两扩展互不知晓对方状态），嫌烦可在批准计划后 `/mode smart`。

## 文件结构

```text
pi-mode-switcher/
├── index.ts          # 扩展入口（全部逻辑，单文件）
├── package.json      # 包元信息 + pi.extensions 清单
├── README.md         # 本文档
├── LICENSE           # MIT
└── .gitignore
```

## License

MIT © huangrx6
