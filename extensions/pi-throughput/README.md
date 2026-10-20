# pi-throughput

在 Pi 状态区常驻显示会话级的四项统计——模型用时、工具调用用时、首 token 平均、输出速度——并把每次模型调用与工具时长的样本写入会话（不进入 LLM 上下文）。

- **四项常驻**：`llm: 10m17s · tools: 3m2s · ttft: 4.8s · rate: 197 t/s`，从会话开始一直在，不会因单次调用结束而清空。
- **模型用时**：Σ（请求发出 → 消息结束），在飞调用也计入，所以数字会随当前调用往上涨。
- **工具调用用时**：Σ 宿主上报的工具执行时长（`tool_execution_end.durationMs`）。
- **首 token 平均**：ΣTTFT ÷ 有首 token 的调用数；单次延迟从请求发出算到第一个内容增量。
- **输出速度**：Σtoken ÷ Σ（首 token → 结束），与宿主会话统计同口径；不是“每次调用 TPS 取平均”。
- **等待计时**：请求已发出、首 token 未到时在四项后追加 `wait 3.2s` 并持续刷新，不撑掉常驻值。
- **调用样本**：每次模型调用一条记录，每次工具执行一条时长记录，不进入 LLM 上下文，恢复会话后四项指标重新从分支重建。

状态文本按 `标签: 值` 排列，标签用短的英文缩写（与底栏其他单元格同一风格），元素之间单空格。

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
| `/throughput stats` | 会话内调用统计：调用数、模型用时、工具调用用时、首 token 平均、输出速度与 p50/p95，按模型分组 |
| `/throughput on` / `off` | 状态显示总开关（关闭只影响显示，样本照常记录） |
| `/throughput display full\|tps\|ttft` | 状态里显示四项 / 仅输出速度 / 仅首 token 平均 |
| `/throughput measurement stream\|e2e` | 输出速度的分母口径 |
| `/throughput history on\|off` | 是否把调用样本与工具用时写入会话 |
| `/throughput reload` | 重新读取配置文件 |

## 指标口径

- **单次调用的时间轴**：

```text
before_provider_request ──► 首个内容增量 ──► …流式… ──► message_end
        │        TTFT = ─────┘                              │
        └────────────── e2e 时长 ───────────────────────────┘
                             └────── stream 时长 ───────────┘
```

- **TTFT**：从请求锚点（`before_provider_request`）到第一个 `text_delta` / `thinking_delta` / `toolcall_delta`。不用 `message_start` 做锚点，因为它发生在流已建立之后，会把首 token 延迟算小。
- **时长单位**：1s 以下用毫秒；1–10s 一位小数；10–60s 取整秒；超过 60s 换成 `1m35s`，超过 1h 换成 `1h5m`。等待计时与常驻值同一套规则，不会一直堆秒数。
- **measurement=stream（默认）**：token ÷（首个增量 → 结束），回答“开始吐字后有多快”。
- **measurement=e2e**：token ÷（请求发出 → 结束），回答“整体等了多久”。
- **四项都是会话累计值**：输出速度是 Σtoken ÷ Σ时长，不是“每次调用 TPS 取平均”——长短调用的权重不同，两种算法在同一份真实会话（81 次调用）上相差 25%（197 vs 248 t/s）。首 token 平均同理，是 ΣTTFT ÷ 有首 token 的调用数；模型用时是 Σ（请求发出 → 消息结束）；工具调用用时是 Σ 工具执行时长。
- **在飞调用**：模型用时与输出速度会把当前调用已发生的那一段叠上去（速率分母不足 `minWindowMs` 时不叠，避免成批 flush 的量化噪声）；首 token 平均只统计已结束的调用。
- 一轮里的工具循环会发起多次模型请求，每次请求都重新锚定单次调用的时间轴，累计值不跨调用漂移。

## 状态发布约定

状态只以纯文本、单一 key（`pi-throughput`）发布到 Pi 状态集合，不携带装饰字形。会话开始到结束的典型演变：

```text
llm: -- · tools: -- · ttft: -- · rate: --
llm: 412ms · tools: -- · ttft: -- · rate: -- · wait 3.2s
llm: 5.6s · tools: 1.4s · ttft: 3.2s · rate: 42.1 t/s
```

只追加、不清空：单次调用结束、回头提问、工具循环都不会把数字变回 `--`；切分支或换会话时会按目标分支的记录重建。

任何按 key 读取 Pi 状态集合的底栏渲染器都可以显示它；本扩展不设置自定义底栏，也不假设由谁绘制。

## 配置

首次运行按需创建 `<agent-dir>/extensions-data/pi-throughput/config.json`（`<agent-dir>` 跟随 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）。`/throughput` 的每次调整都会写回该文件。

```json
{
  "enabled": true,
  "display": "full",
  "measurement": "stream",
  "history": true,
  "minWindowMs": 500,
  "throttleMs": 250
}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `enabled` | 布尔 | 状态显示总开关；关闭不影响样本记录 |
| `display` | `full` / `tps` / `ttft` | 状态里显示四项 / 仅输出速度 / 仅首 token 平均 |
| `measurement` | `stream` / `e2e` | 输出速度的分母口径 |
| `history` | 布尔 | 把调用样本与工具用时写入会话 |
| `minWindowMs` | 100–30000 | 在飞调用叠加速率的最小分母窗口，低于此值只叠模型用时 |
| `throttleMs` | 0–5000 | 状态写入节流，避免每个增量都重绘 |

旧配置里的 `retainFinal` 已失效：四项指标本身就是常驻值，不存在“结束后是否保留”的选择。未知字段会被静默丢弃，坏配置不会打断会话。

## 数据来源与已知边界

- **token 数**：优先用 provider 上报的 `usage.output`。Anthropic / Google 等流式上报累计值，实时数字精确；OpenAI chat-completions 只在最后一个 chunk 给 usage，此时流中按字符类型估算（CJK 1 字 1 token，其余 3.5 字符 1 token），`message_end` 一到就以精确值覆盖。旧的“一律 4 字符 1 token”对中文与工具参数低估约 28%（16188 条真实 assistant 消息统计出的中位误差），流中 rate 因此偏低。
- `usage.output` **已包含推理 token**，不会重复计入；但这也意味着思考耗时长的模型速率会偏低。
- **工具用时**：直接使用宿主 `tool_execution_end.durationMs`（单调时钟测得），不自己计时，也不把排队或中断算进去；没带该字段的调用（工具没真跑）不计入。
- provider 把 token 成批 flush 时，窗口不足的在飞读数没有意义，因此低于 `minWindowMs` 只叠模型用时；已结束调用的 token 数与窗口是精确的，不受该限制。
- 用户中断（Esc）或 provider 报错时保留已测到的部分指标，样本标记为中断。
- 样本只记录模型名、token 数、时长与中断标记，工具记录只存时长，**不记录任何回复内容或工具参数**。
- 关闭 `history` 后四项统计只在本次运行内累计：切分支或换会话时没有记录可重建，会回到占位符。
- 产出 token 与分母极小时（例如几毫秒内结束的调用），Σ/Σ 速率仍会被放大：这里不做限幅，与宿主会话统计保持一致的行为边界。
- 状态文本经过控制字符清洗与显示宽度截断；provider / 模型名异常不会污染底栏。

## 开发与验证

```bash
npm run check   # tsc --noEmit
npm test        # 纯函数、计时状态机、配置与会话生命周期用例
```

## License

MIT
