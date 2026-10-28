# pi-throughput

在 Pi 状态区显示会话级的模型用时、工具调用用时、首内容延迟与输出速度。每次模型调用和工具时长可写入会话，记录不进入 LLM 上下文，也不包含回复内容或工具参数。

```text
20 轮 218 步 · llm: 5.6s · tools: 1.4s · ttft: 3.2s · out: 42.1 t/s
```

四项只在调用结束后结算，流中仅追加并刷新 `wait 3.2s`。回复结束不会清空累计值；恢复会话或切分支时从目标分支的记录重建。

## 安装与命令

随仓库安装后执行 `/reload`：

```bash
pi install "$PWD"
```

| 命令 | 行为 |
| --- | --- |
| `/throughput` | 打开设置面板；非交互模式打印统计和配置 |
| `/throughput stats` | 调用数、中断数、用量、时长、平均首内容延迟、速率与单次速率 p50/p95，含按模型汇总 |
| `/throughput on` / `off` | 只切换状态显示，继续统计与记录 |
| `/throughput display full\|tps\|ttft` | 四项 / 仅速率 / 仅首内容延迟 |
| `/throughput measurement generation\|e2e\|stream` | 切换生成阶段、端到端或正文传输口径 |
| `/throughput history on\|off` | 是否把新样本写入会话；不影响本次运行的统计面板与状态累计 |
| `/throughput reload` | 重新读取配置 |

## 计算口径

```text
请求发出 ──► 首个非空增量（可为思考） ──► 首个正文/工具参数增量 ──► 消息结束
    │                  │                          │                  │
    └────── TTFT ──────┘                          └── stream 时长 ───┘
    └────────────────────── e2e 时长 ─────────────────────────────────┘
```

- **模型用时 `llm`**：成功调用的 Σ（`before_provider_request` → `message_end`），包括成功空响应。失败/取消只计次数，不加入模型用时、TTFT 或速率。
- **工具用时 `tools`**：Σ（`tool_execution_start` → `tool_execution_end`），包括确认与执行；没有派发锚点时用宿主 `durationMs` 兜底。并行调用的时间分别相加，因此可以超过实际经过的时间。
- **首内容延迟 `ttft`**：成功调用中，从请求发出到首个非空 `text_delta`、`thinking_delta` 或 `toolcall_delta` 的平均时间。空协议帧不算首内容；隐藏推理没有增量时，这不等同于服务器内部首 token 时间。
- **生成阶段 `generation`（默认）**：Σ provider 上报的总输出 token ÷ Σ同一组成功调用的「首个内容增量 → 结束」时长，即扣除 TTFT，包含推理。这是模型实际吐字的速度。
- **端到端 `e2e`**：Σ 总输出 token ÷ Σ请求到结束时长，包含 TTFT 与等待，代表用户实际等待体验。
- **正文传输 `stream`**：Σ（总输出 token − provider 上报的推理 token）÷ Σ同一组调用从首个正文/工具参数增量到结束的时长。思考增量不启动正文窗口。有思考但缺少可信拆分时不显示估算速率，面板报告排除数量。

状态直接用 `out:`、`e2e:` 或 `stream:` 标明当前口径，并在 `full` 模式下前置「轮次 · 步数」。两个速率都是客户端测得的比值，不是模型服务器的解码速度。聚合使用 Σtoken ÷ Σ时长，p50/p95 则是同一组样本的单次速率分布，不能把两者当成同一种平均值。

字符估算只随样本保留，绝不进入 token 用量或速率。没有 provider usage 的调用仍可贡献模型用时与首内容延迟；统计面板会说明未上报 usage 的数量。

## 历史与兼容

- 状态栏与统计面板共用本次运行的样本；即使关闭 `history` 或会话写入失败，两处仍保持一致。
- 切分支、换会话或重新加载扩展后，只能从已保存记录重建。关闭历史期间的调用不会补写进会话。
- 旧样本没有正文 token 拆分，仍参与端到端统计；不再用旧的总 token 冒充正文传输 token，流式面板会报告排除数量。
- 旧配置显式选择的 `measurement` 保留；新配置默认 `generation`。旧的 `retainFinal` 与 `minWindowMs` 字段不再生效。
- 失败/取消样本保留中断标记和已测时间以供检查，但累计值不包含其中的部分耗时与输出。

## 配置

配置位于 `<agent-dir>/extensions-data/pi-throughput/config.json`；`<agent-dir>` 跟随 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`。命令调整会保存配置，非法字段退回默认值。

```json
{
  "enabled": true,
  "display": "full",
  "measurement": "generation",
  "history": true,
  "throttleMs": 250
}
```

`throttleMs` 可取 0–5000，控制普通事件的状态写入节流。首内容前的等待计时每 200ms 刷新；收到实际内容、回复结束、分支切换或关闭会话时停止。

时长会换算为毫秒、秒、分和小时，并处理舍入进位；状态文本清洗控制字符并限制显示宽度。

## 测量边界

- 请求锚点位于 provider 请求载荷回调，不包括此前的上下文整理、认证或其他编排时间。重试会重新锚定，不能把单次调用时长当成整轮任务的全部等待。
- 代理缓存、网络缓冲与批量 flush 会压缩客户端观察到的正文窗口，单次 `stream` 和 p95 仍可能很高；需要比较整体等待体验时选择 `e2e`。
- 推理与正文交错时，正文窗口也可能包含后续等待；provider 未完整提供推理拆分时也无法恢复真实正文 token 数。这里提供观测指标，不推断服务器内部生成过程。

## 开发与验证

```bash
npm run check
npm test
```

## License

MIT
