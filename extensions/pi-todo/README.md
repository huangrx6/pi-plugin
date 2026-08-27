# pi-todo

给模型用的待办清单工具：`todo` 工具 + `/todos` 命令 + 编辑器上方常驻 overlay。**状态不落盘**——每次工具调用把全量快照写进 toolResult 的 `details`，生命周期事件从 session branch 重放，因此 `/reload` 和上下文压缩后清单依然健在。

**零运行时依赖**：对 pi 只做 `import type`；参数 schema 是手写的 JSON Schema 字面量（pi 内建工具用的 TypeBox schema 本身就是 JSON Schema）。

## 效果

```text
┌────────────────────────────────────────────────┐
│  (聊天消息区域)                                 │
├────────────────────────────────────────────────┤
│  ● Todos (1/3)                                 │  ← overlay（编辑器上方）
│  ├─ ◐ #2 写测试 (writing tests)                │
│  ├─ ○ #3 部署验证 ⛓#1,#2                       │
│  └─ +2 more (2 completed)                      │
│  > 在这里输入...                                │  ← 编辑器
└────────────────────────────────────────────────┘
```

- **overlay**：进行中 ◐ 高亮、待办 ○、完成 ✓（先被裁掉，收进 `+N more`）；有依赖关系（`⛓`）时才显示 `#id`；超过 12 行内容自动折叠摘要；清单为空自动隐藏
- **`/todos`**：按状态分组打印当前清单

## 模型使用

```json
todo { "action": "create",  "subject": "调研现有工具" }
todo { "action": "update",  "id": 3, "status": "in_progress", "activeForm": "writing tests" }
todo { "action": "delete",  "id": 2 }        // 墓碑：不可再改
todo { "action": "list",    "status": "pending" }
todo { "action": "clear" }
```

状态机：`pending → in_progress → completed → deleted`（deleted 终态）。

## 语义保证

| 保证 | 说明 |
| --- | --- |
| **id 永不复用** | `clear` 只清空列表，`nextId` 单调递增——会话里残留的 "#N" 引用永远不会指向新任务 |
| **墓碑不可变** | 对已删除任务的任何 `update`（含改 subject/metadata）都被拒绝 |
| **依赖健全** | blockedBy 悬空引用 / 已删依赖 / 自阻塞 / 成环全部拒绝，错误信息具体 |
| **无操作检测** | 重复提交相同 update 返回 "No change"（metadata 键序不敏感），防止模型重试循环 |
| **终端安全** | 模型可控文本经过 CSI/OSC/换行/bidi 清洗，无法破坏布局或重排输出 |
| **每会话隔离** | 状态按 sessionId 分槽，子会话/分支不互相污染 |
| **前台跟随** | overlay 渲染**最近**带 UI 的 session（非先到先得）——切换会话即切换清单 |
| **零渲染期 IO** | 行数预算是常量，不读任何配置文件 |

## 持久化原理

```text
todo 调用 → details 携带 {tasks, nextId} 快照 → 追加进 branch
session_start / compact / tree → 从 branch 重放最后一个有效快照
```

pi 的 session 是 append-only、压缩摘要不删 branch 条目，所以重放永远找得到最新快照。

## 与同名扩展共存

工具名 `todo` 是持久化键（branch 里按 `toolName === "todo"` 过滤）。如果同时安装其它也叫 `todo` 的工具扩展会注册冲突——二者取其一。

## 安装

见仓库根 README。

## 已知限制（v0.1）

- 无折叠快捷键、行数预算固定 12（刻意：避免配置文件 + 渲染期读盘）
- overlay 无 i18n（chrome 文案为英文）

## 文件结构

```text
pi-todo/
├── index.ts       # 入口：工具/命令注册 + 事件接线
├── types.ts       # 领域类型 + JSON Schema
├── reducer.ts     # 纯 reducer（状态机/环检测/无操作检测）
├── store.ts       # 会话分槽 + 前台指针 + branch 重放
├── format.ts      # 三视图格式化 + 终端清洗 + 宽度计算
├── overlay.ts     # setWidget overlay
├── globals.d.ts   # pi 运行时 ambient shim（本地 tsc 用）
├── tsconfig.json  # 本地类型检查
└── package.json
```

## License

MIT © huangrx6
