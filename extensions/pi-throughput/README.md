# pi-throughput

在 Pi 状态区常驻显示会话级的四项统计——模型用时、工具调用用时、首 token 平均、输出速度——并把每次模型调用与工具时长的样本写入会话（不进入 LLM 上下文）。

- **四项常驻**：`llm: 10m17s · tools: 3m2s · ttft: 4.8s · rate: 197 t/s`，从会话开始一直在，不会因单次调用结束而清空。
- **模型用时**：Σ（请求发出 → 消息结束），按消息落地结算，不在流中预估。
- **工具调用用时**：Σ（工具派发 → 结果落地），包含权限确认与真正执行两段；宿主的 `durationMs` 只覆盖 `execute()`，仅在没记到派发时兜底。
- **首 token 平均**：ΣTTFT ÷ 有首 token 的调用数；单次延迟从请求发出算到第一个**非空**内容增量。
- **输出速度**：Σtoken ÷ Σ（首 token → 结束），与宿主会话统计同口径；只认 provider 上报的 token，不是“每次调用 TPS 取平均”。
- **等待计时**：请求已发出、首 token 未到时在四项后追加 `wait 3.2s` 并持续刷新——这是流中唯一会变的字段，四项数字等消息落地才更新。
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

- **TTFT**：从请求锚点（`before_provider_request`）到第一个**非空**增量（`text_delta` / `thinking_delta` / `toolcall_delta` 里 `delta` 长度 > 0）。空 delta 只是协议帧，拿它当首 token 会把 TTFT 算成 0；不用 `message_start` 做锚点同理（它发生在流已建立之后）。
- **时长单位**：1s 以下用毫秒；1–10s 一位小数；10–60s 取整秒；超过 60s 换成 `1m35s`，超过 1h 换成 `1h5m`。等待计时与常驻值同一套规则，不会一直堆秒数。
- **measurement=stream（默认）**：token ÷（首个增量 → 结束），回答“开始吐字后有多快”。
- **measurement=e2e**：token ÷（请求发出 → 结束），回答“整体等了多久”。
- **四项都是会话累计值**：输出速度是 Σtoken ÷ Σ时长，不是“每次调用 TPS 取平均”——长短调用的权重不同，两种算法在同一份真实会话（81 次调用）上相差 25%（197 vs 248 t/s）。首 token 平均同理，是 ΣTTFT ÷ 有首 token 的调用数；模型用时是 Σ（请求发出 → 消息结束）；工具调用用时是 Σ（派发 → 结果落地）。中断 / 报错的调用只计次数、不计时间，速率也只收 provider 上报的 token——这两条与宿主 `sessionStats` 投影一致。
- **p50 / p95 是单次调用分布**，与 Σ/Σ 同源（只含未中断、已上报 usage 的调用）：provider 把整批 token 一次性 flush（`streamMs` 只有几毫秒）的调用会读出几千 t/s。本仓 221 次真实调用里有 13 次就是这样（`ttft` 正常、`stream` 只有 6–42ms），p95 因此会被抬得很高；Σ/Σ 主导的常驻 `rate` 只受影响不到 1%。
- **在飞调用不预估**：四项都是已落地调用的累计，流中只有 `wait` 在走。这是宿主 `sessionStats` 的结算时机（assistant/message 落地才累加）——想要“实时预估”就得把估算 token 混进速率，与口径冲突。
- **已知偏差**：宿主用 `step/start` 做模型用时的起点，pi 没有这个事件，我们用 `before_provider_request`，少了宿主编排的几十毫秒；宿主能在 `llm/retry` 后保留首次尝试的首 token 时间，我们的每次 `before_provider_request` 都会重新锚定，重试场景下 TTFT 会偏小。
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
  "throttleMs": 250
}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `enabled` | 布尔 | 状态显示总开关；关闭不影响样本记录 |
| `display` | `full` / `tps` / `ttft` | 状态里显示四项 / 仅输出速度 / 仅首 token 平均 |
| `measurement` | `stream` / `e2e` | 输出速度的分母口径 |
| `history` | 布尔 | 把调用样本与工具用时写入会话 |
| `throttleMs` | 0–5000 | 状态写入节流，避免每个增量都重绘 |

旧配置里的 `retainFinal` 与 `minWindowMs` 已失效（分别随 0.8.0 常驻化、 0.9.0 去掉在飞预估下线）：四项指标本身就是常驻值，也不再有流中预估窗口。未知字段会被静默丢弃，坏配置不会打断会话。

## 数据来源与已知边界

- **token 数**：优先用 provider 上报的 `usage.output`。Anthropic / Google 等流式上报累计值，实时数字精确；OpenAI chat-completions 只在最后一个 chunk 给 usage，此时流中按字符类型估算（CJK 1 字 1 token，其余 3.5 字符 1 token），`message_end` 一到就以精确值覆盖。旧的“一律 4 字符 1 token”对中文与工具参数低估约 28%（16188 条真实 assistant 消息统计出的中位误差），流中 rate 因此偏低。
- `usage.output` **已包含推理 token**，不会重复计入；但这也意味着思考耗时长的模型速率会偏低。
- **工具用时**：从 `tool_execution_start` 到 `tool_execution_end` 的墙钟（派发 → 结果落地），覆盖权限确认与执行两段；宿主 `durationMs` 只含 `execute()`，仅在没记到派发时兜底。
- provider 把 token 成批 flush 时，单次调用的窗口会读出几千 t/s（见上条 p95）；会话 Σ/Σ 只受影响不到 1%。
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
