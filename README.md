# huangrx6 / pi-plugin

[pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) 的个人扩展 monorepo。三个独立扩展，集中维护、跨机器同步。

## 扩展一览

| 扩展 | 一句话定位 | 详细 |
|---|---|---|
| **pi-skill-inject** | 在 prompt 里输入 `/skill-name` 把 skill 内容内联注入当前轮，不切换上下文 | [README](./extensions/pi-skill-inject/README.md) |
| **pi-mode-switcher** | 三级批准控制（ask / smart / full），纯 pi 原生 tool_call 拦截 + `ctx.ui.confirm()` | [README](./extensions/pi-mode-switcher/README.md) |
| **pi-quota-status** | footer 显示 AI 订阅用量（OpenCode Go / 智谱 GLM），模型切换自动换数据源 | [README](./extensions/pi-quota-status/README.md) |

每个子目录都是**独立可发布的 pi package**——可单独 `pi install`，也可整库安装。

## 一行命令安装

### 标准方式：用 pi 自身的包管理器

```bash
# 装全部 3 个扩展（推荐）—— 写到 ~/.pi/agent/settings.json
pi install git:github.com/huangrx6/pi-plugin

# 装到项目级（团队共享，.pi/settings.json）
pi install -l git:github.com/huangrx6/pi-plugin

# 临时试用（不写 settings，跑一次就丢）
pi -e git:github.com/huangrx6/pi-plugin

# 只装其中一个（从子目录直接装）
pi install git:github.com/huangrx6/pi-plugin/tree/main/extensions/pi-skill-inject
```

> `pi install` 是 [pi 包管理命令](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/packages.md)。包会被克隆到 `~/.pi/agent/git/<host>/<path>` 并注册到 `settings.json` 的 `packages` 字段。安装后重启 pi 或 `/reload` 生效。

### 高级方式：交互式脚本（选择性 + 自定义路径）

`pi install` 永远装到固定的 `~/.pi/agent/git/...` 或 `.pi/git/...`。如果你想：
- **只装部分扩展**（不装全部 3 个）
- **装到自定义目录**（比如 `~/.pi/agent/extensions/`，让 pi 自动发现而不是包加载机制）
- **用 symlink 还是 copy**（脚本默认 symlink）

用仓库根的 `bin/install.sh`：

```bash
# 交互式：列出所有扩展 + 让选 + 让选路径 + 让选 symlink/copy
curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh | bash

# 只装指定扩展到全局扩展目录（symlink 模式）
curl -fsSL https://raw.githubusercontent.com/huangrx6/pi-plugin/main/bin/install.sh \
  | bash -s -- --only pi-skill-inject,pi-mode-switcher --target ~/.pi/agent/extensions

# 拷贝模式（不依赖原仓库存在）
curl ... | bash -s -- --only pi-quota-status --target ~/.pi/agent/extensions --mode copy

# 非交互（脚本/CI 用）
curl ... | bash -s -- --only pi-skill-inject --target ~/.pi/agent/extensions -y
```

完整选项：
- `--only <list>` — 逗号分隔的扩展名；不传则交互式让选
- `--target <path>` — 安装目录；默认 `~/.pi/agent/extensions`
- `--mode <mode>` — `symlink`（默认，单一源真相，便于更新）或 `copy`（独立副本）
- `-y, --yes` — 跳过所有确认
- `--repo <owner/repo>` — 源仓库（默认 `huangrx6/pi-plugin`）

## 目录结构

```
pi-plugin/
├── README.md                       # 本文件（外层索引）
├── package.json                    # pi-package 元数据 + pi.extensions 清单
├── LICENSE                         # MIT
├── bin/
│   └── install.sh                  # 高级安装脚本
└── extensions/
    ├── pi-skill-inject/
    │   ├── README.md               # 内层：详细介绍 + 实现原理
    │   ├── index.ts                # 扩展入口
    │   ├── package.json            # 子包（声明 pi.extensions）
    │   └── LICENSE
    ├── pi-mode-switcher/
    │   ├── README.md
    │   ├── index.ts
    │   ├── package.json
    │   └── LICENSE
    └── pi-quota-status/
        ├── README.md
        ├── index.ts
        ├── package.json
        └── LICENSE
```

每个 `extensions/<name>/` 是个**完整 pi package**——可以单独 `pi install git:github.com/huangrx6/pi-plugin/tree/main/extensions/<name>`。

## 维护约定

- 各扩展独立 version（`extensions/<name>/package.json` 的 `version`），不强制同步
- `bin/install.sh` 用 sparse-checkout 拉 extensions/ 目录，省时间和带宽
- 升级：`pi install git:github.com/huangrx6/pi-plugin@<new-ref>` 或在 `~/.pi/agent/settings.json` 改 pinned ref 后 `pi update --extensions`

## License

MIT © huangrx6