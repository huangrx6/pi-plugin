<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/mode-switcher.svg" alt="pi-mode-switcher" width="48" />
</p>

# pi-mode-switcher

<p align="center"><strong>每次工具调用前的权限门：ask / smart / full。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

拦截 Pi 的 `tool_call` 事件，在工具运行前决定放行、确认或阻止。这是整条工具调用链上唯一的权限层；任务流路由、提示注入与会话管理不在其范围内。

## 模式

| 模式 | 命令 | 行为 | 适用 |
| --- | --- | --- | --- |
| Ask | `/mode ask` | 所有写入 / 网络 / 未知工具都弹确认框 | 想看到每一步 |
| Smart（默认） | `/mode smart` | 仅危险操作（`rm -rf`、`sudo`、`git push --force`…）弹确认，其余放行 | 日常开发 |
| Full | `/mode full` | 零对话框，全部放行 | 高信任 / 自动化 |

无参数执行 `/mode` 打开原生选择器：当前模式排在首位，取消静默返回。

## 行为矩阵

| 工具调用 | ask | smart | full |
| --- | --- | --- | --- |
| `read` / `ls` / `grep` / `find` | 放行 | 放行 | 放行 |
| 只读 bash（`ls`、`cat`、`git status`） | 放行 | 放行 | 放行 |
| 文件写入（`write` / `edit` / `apply_patch`） | 确认 | 放行 | 放行 |
| 网络（`curl` / `wget` / `fetch_content` / `web_search`） | 确认 | 放行 | 放行 |
| MCP 工具 / 未知工具 | 确认 | 放行 | 放行 |
| 写入 bash（`git push`、`rm`、`tee`、`mkdir`） | 确认 | 放行 | 放行 |
| 危险 bash（`rm -rf`、`sudo`、`mkfs`、`git push --force`） | 确认 | 确认 | 放行 |

## 复合命令安全

v0.1.1 修复过一个真实漏洞：`echo hi && rm -rf /x` 曾被整句判定为只读、在 ask 与 smart 模式下都直接放行。现在命令按 `&&` / `||` / `;` / `|` / 换行，以及 `$( )` 与反引号替换体拆段，**逐段独立分析**——任何无法证明只读的段落都会让整条命令按写入处理；管道进解释器（`curl … | sh`）按远程代码执行标记为危险。

bash 判定是保守的正则启发式，不是 AST 解析；无法判定的情形一律落到更安全的一侧（写入）。

## 状态与持久化

- 模式写入 `~/.pi/agent/mode-switcher.json`，重启后恢复
- 可选状态是主题化的纯文本（如 `⚙ 权限 smart`），仅作摘要——查看与切换始终可以通过 `/mode` 独立完成
- 确认框文本先清理控制序列、再按显示宽度截断：命令、路径、URL 与查询不能注入控制字符，也不会截断半个中文字符

## 安装

```bash
pi install git:github.com/huangrx6/pi-plugin
```

重启 Pi 或执行 `/reload`。零依赖、零配置。

## 开发

```bash
cd extensions/pi-mode-switcher
npm run check      # tsc --noEmit
npm test           # 复合命令风险 + CJK 宽度 + 控制序列回归
```

<details>
<summary>文件结构</summary>

```text
pi-mode-switcher/
├── index.ts          # tool_call 处理 + checkPermission + bash 启发式
├── display.ts        # 对话框文本净化与显示宽度截断
├── tests/            # 复合命令 / 显示 / 交互测试
├── globals.d.ts      # Pi 运行时类型 ambient shim
├── tsconfig.json
├── package.json
├── README.md
└── LICENSE
```

</details>

## License

MIT © huangrx6
