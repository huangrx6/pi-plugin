# huangrx6 / pi-plugin

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的个人扩展合集。独立扩展，集中维护。

## 扩展一览

| 扩展 | 一句话定位 | 详细 |
|---|---|---|
| **pi-skill-inject** | prompt 里输入 `/skill-name` 把 skill 内容内联注入当前轮 | [README](./extensions/pi-skill-inject/README.md) |
| **pi-mode-switcher** | 三级批准控制（ask / smart / full），纯 pi tool_call 拦截 | [README](./extensions/pi-mode-switcher/README.md) |
| **pi-quota-status** | footer 显示 AI 订阅用量（OpenCode Go / 智谱 GLM），自动切数据源 | [README](./extensions/pi-quota-status/README.md) |
| **pi-policy-engine** | 自动路由 workflow（quick/standard/strict）+ 任务级 plan-then-execute + 机械门禁 | [README](./extensions/pi-policy-engine/README.md) |

每个 `extensions/<name>/` 是独立可发布的 pi package——可单独 `pi install`，也可整库安装。

> **扩展职责边界**：
> - `pi-skill-inject` 管「怎么把 skill 喂给当前轮」
> - `pi-mode-switcher` 管「每次工具调用的人工批准」
> - `pi-policy-engine` 管「自动路由 workflow + 任务级 plan + 执行门禁」
> - `pi-quota-status` 管「footer 状态显示」
>
> `mode-switcher`（人工每次确认）和 `policy-engine`（任务级自动 plan-then-execute）正交，常一起用：mode-switcher 给总闸，policy-engine 在 strict 任务上加额外保险。

---

## 安装

### 方式一：`pi install`（推荐）

pi 自带包管理，直接装到标准位置 `~/.pi/agent/git/...` 并写 `settings.json`：

```bash
pi install git:github.com/huangrx6/pi-plugin
```

装完重启 pi 或 `/reload` 生效。升级：`pi update --extensions`。

### 方式二：手动软链到 pi 自动发现目录

如果你想走 pi 的自动发现（`~/.pi/agent/extensions/*/index.ts`），不写 `settings.json`：

```bash
git clone --depth 1 https://github.com/huangrx6/pi-plugin \
  ~/.pi/agent/extensions/_huangrx6-pi-plugin
for ext in ~/.pi/agent/extensions/_huangrx6-pi-plugin/extensions/*/; do
  ln -sfn "$ext" ~/.pi/agent/extensions/$(basename "$ext")
done
```

升级：`cd ~/.pi/agent/extensions/_huangrx6-pi-plugin && git pull`，然后 `/reload`。

### 方式三：仓库自带的一行命令脚本

如果嫌上面长，仓库根有 `bin/install.sh` 做同样的事，**全交互**——列出 extensions 让勾选、问目标目录、确认创建：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh)
```

脚本会依次问：

1. 装哪些 extensions（编号 / `all` / 回车全选）
2. 装到哪个目录（默认 `~/.pi/agent/extensions`）
3. 目录不存在是否创建

工作原理 = 方式二（git clone 到目标 + 软链各 extension），升级 `git pull`。

---

## 三种方式怎么选

| 方式 | 装到哪 | 升级 | 适合 |
|---|---|---|---|
| `pi install` | `~/.pi/agent/git/...` + `settings.json` 的 `packages` | `pi update --extensions` | 大多数人（最少折腾）|
| 手动软链 | `~/.pi/agent/extensions/<name>` 软链 | `git pull` 后 `/reload` | 想用 pi 自动发现，不想写 `settings.json` |
| `bin/install.sh` | 同上 | 同上 | 嫌方式二命令太长 |

---

## 目录结构

```
pi-plugin/
├── README.md                  # 本文件
├── package.json               # pi-package 元数据
├── LICENSE                    # MIT
├── bin/
│   └── install.sh             # 方式三的可选脚本
└── extensions/
    ├── pi-skill-inject/
    │   ├── README.md          # 详细说明
    │   ├── index.ts
    │   ├── package.json
    │   └── LICENSE
    ├── pi-mode-switcher/
    ├── pi-quota-status/
    └── pi-policy-engine/
```

## License

MIT © huangrx6