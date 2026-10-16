# pi-throughput

在 Pi 状态区实时显示模型输出速率与首 token 延迟，并把每次模型调用的样本写入会话，供会话内复盘。

- **实时速率**：`速率：42.1 t/s`，流式过程中持续刷新，结束后停在终值。
- **首 token 延迟**：`首字：412ms`，从请求发出算到第一个内容增量；越长越换单位（`3.2s` → `42s` → `1m35s` → `1h5m`）。
- **等待计时**：请求已发出、首 token 未到时显示 `首字：等待 3.2s` 并持续刷新，能直接看到“已经等了多久”。
- **调用样本**：每次模型调用一条记录（模型、token、TTFT、时长、是否中断），不进入 LLM 上下文，恢复会话后还能统计。

状态文本按 `描述：值` 排列，描述是两字中文，元素之间单空格；同一写法与底栏其他单元格一致。

## 安装

随本仓库一起安装（根 manifest 已注册）：

```bash
pi install "$PWD"
```

单文件试运行：

```bash
pi --extension ./index.ts
```

执行 `/reload` 后生效。

## 使用

| 命令 | 行为 |
| --- | --- |
| `/throughput` | 打开设置面板（非交互模式打印当前设置与会话统计） |
| `/throughput stats` | 会话内调用统计：次数、平均 / p95 速率与 TTFT，按模型分组 |
| `/throughput on` / `off` | 状态显示总开关（关闭只影响显示，样本照常记录） |
| `/throughput display full\|tps\|ttft` | 状态里显示哪些指标 |
| `/throughput measurement stream\|e2e` | 速率分母口径 |
| `/throughput retain on\|off` | 回复结束后是否保留终值 |
| `/throughput history on\|off` | 是否把调用样本写入会话 |
| `/throughput reload` | 重新读取配置文件 |

## 指标口径

```text
before_provider_request ──► 首个内容增量 ──► …流式… ──► message_end
        │        TTFT = ─────┘                              │
        └────────────── e2e 时长 ───────────────────────────┘
                             └────── stream 时长 ───────────┘
```

- **TTFT**：从请求锚点（`before_provider_request`）到第一个 `text_delta` / `thinking_delta` / `toolcall_delta`。不用 `message_start` 做锚点，因为它发生在流已建立之后，会把首 token 延迟算小。
- **时长单位**：1s 以下用毫秒；1–10s 一位小数；10–60s 取整秒；超过 60s 换成 `1m35s`，超过 1h 换成 `1h5m`。等待计时和终值同一套规则，不会一直堆秒数。
- **measurement=stream（默认）**：token ÷（首个增量 → 结束），回答“开始吐字后有多快”。
- **measurement=e2e**：token ÷（请求发出 → 结束），回答“整体等了多久”。
- 一轮里的工具循环会发起多次模型请求，每次请求都重新锚定，指标不跨调用漂移。

## 状态发布约定

状态只以纯文本、单一 key（`pi-throughput`）发布到 Pi 状态集合，不携带装饰字形。一次请求里的典型演变：

```text
首字：等待 3.2s  →  首字：3.2s  →  速率：42.1 t/s 首字：3.2s
```

任何按 key 读取 Pi 状态集合的底栏渲染器都可以显示它；本扩展不设置自定义底栏，也不假设由谁绘制。

## 配置

首次运行按需创建 `<agent-dir>/extensions-data/pi-throughput/config.json`（`<agent-dir>` 跟随 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）。`/throughput` 的每次调整都会写回该文件。

```json
{
  "enabled": true,
  "display": "full",
  "measurement": "stream",
  "retainFinal": true,
  "history": true,
  "minWindowMs": 500,
  "throttleMs": 250
}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `enabled` | 布尔 | 状态显示总开关；关闭不影响样本记录 |
| `display` | `full` / `tps` / `ttft` | 状态里显示哪些指标 |
| `measurement` | `stream` / `e2e` | 速率分母口径 |
| `retainFinal` | 布尔 | 结束后保留终值直到下一次请求 |
| `history` | 布尔 | 把调用样本写入会话 |
| `minWindowMs` | 100–30000 | 流中速率的最小分母窗口，低于此值先只显示首 token 延迟 |
| `throttleMs` | 0–5000 | 状态写入节流，避免每个增量都重绘 |

非法值退回默认值，坏配置不会打断会话。

## 数据来源与已知边界

- **token 数**：优先用 provider 上报的 `usage.output`。Anthropic / Google 等流式上报累计值，实时数字精确；OpenAI chat-completions 只在最后一个 chunk 给 usage，此时流中用字符数 ÷ 4 估算，`message_end` 一到就以精确值覆盖。
- `usage.output` **已包含推理 token**，不会重复计入；但这也意味着思考耗时长的模型速率会偏低。
- provider 把 token 成批 flush 时，窗口不足的流中读数没有意义，因此低于 `minWindowMs` 先只显示首 token 延迟；结束后的终值是精确平均，不受该限制。
- 用户中断（Esc）或 provider 报错时保留已测到的部分指标，样本标记为中断。
- 样本只记录模型名、token 数、时长与中断标记，**不记录任何回复内容或工具参数**。
- 状态文本经过控制字符清洗与显示宽度截断；provider / 模型名异常不会污染底栏。

## 开发与验证

```bash
npm run check   # tsc --noEmit
npm test        # 纯函数、计时状态机、配置与会话生命周期用例
```

## License

MIT
