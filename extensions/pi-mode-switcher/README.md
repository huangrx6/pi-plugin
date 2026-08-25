<!-- markdownlint-disable MD013 MD033 MD036 MD041 -->
<div align="center">

# 🛡️ pi-mode-switcher

**工具权限层 — 在每个 `tool_call` 之前决定放行还是弹框**

类 Claude Code 的权限级别，纯 pi 原生实现，零第三方依赖

</div>

---

## 它做什么

拦截 `tool_call` 事件，在每个工具**执行前**判断放行 / 弹框 / 拦下。是整个 pi 工具调用链上的**唯一权限层**。

它**不**做：任务流程编排、模型行为约束、prompt 注入——那是别的扩展的事。

## 三种模式

| 模式 | 命令 | 行为 | 适合 |
| --- | --- | --- | --- |
| 🔵 **请求批准** | `/mode ask` | 编辑文件 / 联网 / 未知工具**全部弹框** | 你想看到每一步 |
| 🟡 **帮我批准** | `/mode smart` *(默认)* | 只对**危险操作**（`rm -rf`、`sudo`、`git push --force`）弹框，其他放行 | 日常开发 |
| 🔴 **完全访问** | `/mode full` | **零弹框**，全自动过 | 信任度高 / 自动化脚本 |

切换用 `/mode ask` / `/mode smart` / `/mode full`，或者无参 `/mode` 弹交互选择器（像 `/model` 一样）。

## 模式行为对比

| 工具调用 | 🔵 ask | 🟡 smart | 🔴 full |
| --- | --- | --- | --- |
| `read` / `ls` / `grep` / `find` | ✅ auto | ✅ auto | ✅ auto |
| 只读 bash（`ls`、`cat`、`git status`） | ✅ auto | ✅ auto | ✅ auto |
| 写文件（`write` / `edit` / `apply_patch` …） | 🗣️ prompt | ✅ auto | ✅ auto |
| 联网（`curl` / `wget` / `fetch_content` / `web_search`） | 🗣️ prompt | ✅ auto | ✅ auto |
| MCP 工具 / 未知工具 | 🗣️ prompt | ✅ auto | ✅ auto |
| 写 bash（`git push`、`rm`、`tee`、`mkdir`…） | 🗣️ prompt | ✅ auto | ✅ auto |
| **危险**（`rm -rf`、`sudo`、`mkfs`、`git push --force`） | 🗣️ prompt | 🗣️ prompt | ✅ auto |

🗣️ = 弹确认框，你点 **Yes/No** 决定放行或拦截。

## 它怎么工作

pi 在每次工具调用前触发 `tool_call` 事件，扩展可以异步拦截：

```typescript
pi.on("tool_call", async (event, ctx) => {
  const reason = await checkPermission(currentMode, event.toolName, event.input, confirm);
  if (reason) {
    return { block: true, reason };   // 拦下 → 模型看到 reason 并自我修正
  }
  return undefined;                     // 放行
});
```

**决策链**（每次工具调用）：

```text
只读白名单 (read/ls/grep/find + 只读 bash) → 永远放行
        ↓
mode === "full"  → 全部放行，零弹框
        ↓
mode === "ask"   → 只读 → 放行；其余全部（写/联网/MCP/未知）→ confirm 弹框
        ↓
mode === "smart" → 危险 bash（rm -rf/sudo/...）→ confirm 弹框；其余放行
```

**bash 启发式**（尽力而为的正则集合）：

- 写操作：`rm`、`mv`、`cp`、`mkdir`、`chmod`、`sed -i`、重定向到非 `/dev/null`、git 写命令、包管理、网络命令
- 危险：`rm -r/-f`、`sudo`、`mkfs`、`dd of=`、`git reset --hard`、`git push --force`

> ⚠️ 复杂命令（`&&` 组合、`$(...)` 替换、别名）可能漏判——漏判的按"写"处理（更安全）。这不是 AST 解析，是保守启发式。

## 持久化

模式写到 `~/.pi/agent/mode-switcher.json`，重启 pi 保持。footer 状态行显示当前模式：

```text
🔌 MCP: 3 servers enabled ◈ mode:帮我批准 LSP Inactive
```

（`mode:请求批准` 青色 / `mode:帮我批准` 黄色 / `mode:完全访问` 红色）

## 安装

```bash
pi install git:github.com/huangrx6/pi-mode-switcher
```

重启 pi 或 `/reload` 生效。**零依赖、零配置**。

## 文件结构

```text
pi-mode-switcher/
├── index.ts          # 单文件（tool_call handler + checkPermission + isWriteBash/isRiskyBash）
├── package.json
├── README.md
└── LICENSE
```

## License

MIT © huangrx6
