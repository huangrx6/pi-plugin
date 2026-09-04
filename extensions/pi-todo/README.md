<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="../../assets/icons/todo.svg" alt="pi-todo" width="48" />
</p>

# pi-todo

<p align="center"><strong>工作区级持久任务清单：模型工具、用户命令与编辑器状态条。</strong></p>

<p align="center">
  <a href="https://github.com/huangrx6/pi-plugin/actions/workflows/ci.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/huangrx6/pi-plugin/ci.yml?branch=main&style=flat-square&label=build" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square" />
</p>

一个模型可调用的 `todo` 工具、一个面向用户的 `/todos` 命令、一条编辑器上方的状态条。状态由按工作区存储的**持久信封**持有——`/reload` 与内置压缩都不会丢清单：工作区是身份，会话不是。

零运行时依赖；Pi 导入为类型导入；工具参数 schema 是手写 JSON Schema。

## 入口与操作

`/todos` 无参数直接列出进行中、可开始与被阻塞的任务。方向键选择，回车打开该状态适用的操作：进行中任务可完成，可开始任务可开始，被阻塞任务可查看原因，所有活跃任务均可改名。「新增」直接输入任务名称。「历史」收纳已完成与已归档任务，选中后可重开、归档或恢复；「总览」保留完整分组摘要。取消任何列表都静默返回，不产生消息，也不写数据。

```text
RUNNING
▶ #11 修正令牌校验

READY
◆ #20 补充集成测试
◆ #21 更新文档
  +15 more ready

BLOCKED
○ #50 等待 #21 完成

✓ 6 completed · /todos completed
```

| 直接命令 | 行为 |
| --- | --- |
| `/todos next` | 现在可以开始哪些任务（完整 READY 列表） |
| `/todos start / finish / reopen <id>` | 状态流转 |
| `/todos archive <id>… / archive completed` | 归档（批量或全部已完成） |
| `/todos restore <id>… / restore archived` | 恢复 |
| `/todos ready / blocked / completed / archived` | 分组全量列表 |
| `/todos all` | 含归档的完整历史状态 |
| `/todos <id>` | 详情：标准行 + 说明 + 阻塞原因 + 完成后解锁 |
| `/todos here` | 工作流恢复：当前任务 + 完成后会解锁什么 |
| `/todos commands` | 完整兼容命令目录 |

模型侧工具：`create / update / delete / list / clear`，状态机 `pending → in_progress → completed → deleted`（`deleted` 为终态，ID 永不复用）。

## 编辑器状态条

默认紧凑视图最多两行，使用终端主题颜色，优先保留任务名称；窄窗口按中文、组合字符与 emoji 的实际显示宽度换行或截断，任务文本中的终端控制序列先被清除。没有活跃任务时自动隐藏。

```text
▶ #11 修正令牌校验 · 1/3 已完成 · /todos
> 补充要求…
```

`/todos display compact|full|hidden` 调整本次会话的显示方式。状态条只是展示——隐藏它不影响任何操作，`/todos` 始终是独立入口。列表、详情与工具结果的着色全部走主题 token（▶ accent / ◆ 默认 / ○ muted / ✓ success），无主题路径与纯文本逐字节一致。

## 语义保证

| 保证 | 含义 |
| --- | --- |
| **原子变更** | 变更类命令全有或全无：任一目标不满足前置条件，则不修改任何目标 |
| **ID 永不复用** | `clear` 清空列表但 `nextId` 只增不减；对话中过期的 `#N` 引用永远是死引用 |
| **墓碑不可变** | 对已删除任务的任何 `update` 都被拒绝 |
| **依赖健康** | 悬空 `blockedBy`、已删除依赖、自阻塞、循环依赖全部拒绝并给出具体错误 |
| **无操作检测** | 字段完全相同的重复 `update` 返回「无变化」，防止模型重试循环 |
| **一个命令一个快照** | 每条命令恰好一次持久加载 + 一次提交；提交冲突返回明确的 `cas-conflict` 错误而不是透明重试 |
| **终端安全** | 模型可控字符串在渲染前清除 CSI / OSC / 换行 / 双向控制 |
| **工作区身份** | 状态以 `canonical realpath(cwd)` 的 SHA-256 为键；同工作区换会话清单不变，`/reload` 静默恢复状态条 |

变更影响下游就绪状态时，响应会附带 `Now ready` 或 `Re-blocked` 段落。`archive` 与 `all` / `archived`、`restore` 与 `all` / `completed` 的组合被策略性拒绝，错误信息解释原因并给出正确选择器。

## 持久化

```text
<agentDir>/pi-todo/<sha256(workspace:v1:canonical_realpath)>
{ schemaVersion: 1, revision: 17, state: { tasks: [...], nextId: 1000 } }
```

`revision` 单调递增，作为 CAS 期望版本；提交失败时已格式化的成功文本一并丢弃。会话分支不再承担状态职责——冷启动只做一次静默的持久加载来点亮状态条，失败也不影响 Pi 启动。

## 安装

```bash
pi install git:github.com/huangrx6/pi-plugin
```

重启 Pi 或执行 `/reload`。

## 已知限制

- 分区行预算固定（2 / 3 / 2），尚未按终端宽度自适应——Pi 的命令 / UI 契约暂不暴露终端宽度
- 状态以 canonical realpath 为键：重命名或移动工作区目录会得到全新清单（位置即身份，设计使然）
- 工具名 `todo` 是持久化键：同时安装另一个注册同名工具的扩展会冲突，二选一
- `activeForm` 只进模型提示，不进 CLI 视图；`description` 仅在 `/todos <id>` 存在时渲染

## 开发

```bash
cd extensions/pi-todo
npm run check      # tsc --noEmit
npm test           # glob 全部 *.test.ts（含渲染 / 交互回归）
```

测试使用 `os.tmpdir()` + `mkdtemp` 存放临时文件。

<details>
<summary>文件结构（按层）</summary>

```text
pi-todo/
├── index.ts                    # 工具 + /todos + 生命周期接线
├── types.ts                    # 领域类型 + JSON Schema
├── reducer.ts                  # 纯状态机
├── 格式层    format.ts · graph-format.ts · overview-format.ts ·
│            task-detail-format.ts · current-task-format.ts ·
│            direct-unlock-format.ts · mutation-format.ts ·
│            workflow-format.ts · selector-policy-notice.ts
├── 语法层    parse-todos-command.ts · mutation-command.ts ·
│            graph-command.ts · workflow-command.ts
├── 查询层    graph-query.ts · graph.ts · projection.ts · read-model.ts
├── 持久层    persistence-contract.ts · persistence-error.ts ·
│            persistence-codec.ts · persistence-migration.ts ·
│            durable-store.ts · file-durable-store.ts · workspace-scope.ts
├── 回放层    replay-context.ts · replay-engine.ts · replay-capture.ts
├── 展示层    overlay.ts · overlay-snapshot-cache.ts · runtime-persistence.ts
└── 测试      test-harness.ts + 30 个 *.test.ts
```

</details>

## License

MIT © huangrx6
