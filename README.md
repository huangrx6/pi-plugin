<!-- markdownlint-disable MD013 MD033 MD036 MD041 -->
<div align="center">

# ⚙️ huangrx6/pi-plugin

**一个仓库 · 四个独立扩展 · 互不感知**

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的个人扩展合集。每个扩展都是**独立可发布**的 pi package，按需装。

[![CI — pi-policy-engine](https://img.shields.io/badge/CI-pi--policy--engine-blue?style=flat-square&logo=github-actions&logoColor=white)](https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml)
[![CI — pi-quota-status](https://img.shields.io/badge/CI-pi--quota--status-blue?style=flat-square&logo=github-actions&logoColor=white)](https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml)
[![CI — markdown-lint](https://img.shields.io/badge/CI-markdown--lint-blue?style=flat-square&logo=github-actions&logoColor=white)](https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)

</div>

---

## 🎁 选你要的，按需装

| 扩展 | 一句话 | 工作在哪 |
| --- | --- | --- |
| ⚡ **[pi-skill-inject](./extensions/pi-skill-inject/README.md)** | prompt 里输入 `/skill-name`，把 skill 内容内联注入当前轮 | model layer |
| 🛡️ **[pi-mode-switcher](./extensions/pi-mode-switcher/README.md)** | 三级批准控制（ask / smart / full），每个 `tool_call` 之前决定放行还是弹框 | tool layer |
| 📊 **[pi-quota-status](./extensions/pi-quota-status/README.md)** | footer 显示 AI 订阅用量（OpenCode Go / 智谱 GLM / Kimi / DeepSeek / OpenRouter），按模型自动切数据源 | display |
| 🧩 **[pi-footer-composer](./extensions/pi-footer-composer/README.md)** | 接管 footer 渲染为表格布局：环境、用量、上下文、模型、每个扩展状态各占一格，按终端宽度自动分行 | display |
| 🛠️ **[pi-policy-engine](./extensions/pi-policy-engine/README.md)** | 自动路由 workflow（quick/standard/strict）+ 任务级 plan-then-execute + preview/history/diff/validate 调试命令 | model layer |

> 每个 `extensions/<name>/` 是**独立可发布**的 pi package——可单独 `pi install`，也可整库安装。
> 扩展之间**互不感知**：一个挂了不影响另一个；不需要某个就别装某个；同一层（model / tool / display）的扩展各自独立工作。

---

## 📦 安装

### 三选一

| | 方式 | 适合 |
| --- | --- | --- |
| 📦 | **`pi install`（推荐）**——一行命令，pi 自动管升级 | 大多数人（最少折腾）|
| 🔗 | **手动软链**——`git clone` + `ln -s`，自己 `git pull` 升级 | 想用 pi 自动发现机制，不想改 `settings.json` |
| 🚀 | **`bin/install.sh` 交互脚本**——全问、克隆、软链一把梭 | 想要交互式引导 |

### 📦 方式一：`pi install`（推荐）

```bash
pi install git:github.com/huangrx6/pi-plugin
```

装完重启 pi 或 `/reload` 生效。**升级**：`pi update --extensions`。

### 🔗 方式二：手动软链

```bash
git clone --depth 1 https://github.com/huangrx6/pi-plugin \
  ~/.pi/agent/extensions/_huangrx6-pi-plugin
for ext in ~/.pi/agent/extensions/_huangrx6-pi-plugin/extensions/*/; do
  ln -sfn "$ext" ~/.pi/agent/extensions/$(basename "$ext")
done
```

升级：`cd ~/.pi/agent/extensions/_huangrx6-pi-plugin && git pull`，然后 `/reload`。

### 🚀 方式三：交互脚本

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh)
```

脚本依次问你：装哪些 / 装到哪 / 目录不存在是否创建。

---

## 🗂 仓库长这样

```text
┌─────────────────────────────────────────────────────────────────┐
│  pi-plugin/                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ├── README.md          ← 你在这                                  │
│  ├── package.json       ← pi-package 元数据（root pi.extensions）   │
│  ├── AGENTS.md          ← 仓库规约（给未来 agent 会话读）           │
│  ├── LICENSE            ← MIT                                     │
│  ├── bin/                                                         │
│  │   └── install.sh     ← 方式三的可选脚本                        │
│  └── extensions/        ← 4 个独立可发布包                         │
│      ├── pi-skill-inject/  ← ⚡ model layer                      │
│      ├── pi-mode-switcher/  ← 🛡️ tool layer                       │
│      ├── pi-quota-status/   ← 📊 display                          │
│      ├── pi-footer-composer/ ← 🧩 display                          │
│      └── pi-policy-engine/  ← 🛠️ model layer                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠 仓库维护

```bash
# 新增扩展 = 建目录 + 在根 package.json 的 pi.extensions 里注册
mkdir extensions/my-new-ext
# (实现后)
npm test              # 每个扩展自带 self-test + smoke
```

完整规约见 [AGENTS.md](./AGENTS.md)（语言选择、manifest 铁律、check 脚本、扩展独立性、提交规范等）。

---

## 💡 装上即用，缺哪个补哪个

| 你想… | 装 |
| --- | --- |
| 在 prompt 里用 `/skill-name` 直接喂 skill 内容进当前轮 | [pi-skill-inject](./extensions/pi-skill-inject/README.md) |
| 每个工具调用前人工确认 / 自动过 / 危险拦截（ask / smart / full 三档） | [pi-mode-switcher](./extensions/pi-mode-switcher/README.md) |
| footer 看到 OpenCode Go / 智谱 / Kimi 等订阅用量 | [pi-quota-status](./extensions/pi-quota-status/README.md) |
| 让模型自动按任务复杂度走 quick / standard / strict 流程，strict 时停下来等批准 | [pi-policy-engine](./extensions/pi-policy-engine/README.md) |

> 装了哪个就用哪个的能力，**互不依赖、互不冲突**——这就是它们该有的样子。

---

## License

MIT © huangrx6
