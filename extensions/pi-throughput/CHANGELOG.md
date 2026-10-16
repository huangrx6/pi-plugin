# Changelog

## 0.2.0 - 2026-10-16

- 状态文本改为不带装饰字形的纯文本：`42.1 t/s · 首 token 412ms`。原先的 ⚡ / ⏱ 前缀会被按字形清洗的底栏渲染器只吃掉前导字符，造成同一格内混排。
- 只渲染已经测到的指标：首 token 未到时不再输出 `… t/s` 占位，速率窗口未满时先只显示首 token 延迟。
- 等待首 token 与速率窗口未满期间改为盲文动画占位（`⠋ 等待首 token…`、`⠋ 测速中…`），80ms 帧间隔与宿主 spinner 一致；仅交互模式跑计时器并 `unref()`，首个增量、应答结束、会话关闭都会停表。

## 0.1.0 - 2026-10-16

- 在 Pi 状态集合发布实时输出速率与首 token 延迟（单一纯文本 key `pi-throughput`），流中按 `throttleMs` 节流刷新，结束后保留终值。
- 以 `before_provider_request` 为请求锚点、首个内容增量为 TTFT 终点；工具循环中的每次模型请求都重新锚定。
- 提供 `stream`（首 token 之后）与 `e2e`（含等待）两种速率口径，以及 `full` / `tps` / `ttft` 三种显示选择。
- 低于 `minWindowMs` 的流中速率只显示占位符，避免成批 flush 时的量化噪声；终值不受窗口限制。
- 每次模型调用写一条会话样本（模型、token、TTFT、时长、中断标记），不进入 LLM context，供 `/throughput stats` 按模型汇总平均值与 p95。
- 提供 `/throughput` 设置面板与子命令，配置持久化到 `<agent-dir>/extensions-data/pi-throughput/config.json`；非法值与坏文件退回默认值。
- provider 未上报 usage 时以字符数 ÷ 4 估算，`message_end` 的精确值一到即覆盖；token 数按显示宽度截断，状态文本先清洗控制字符。
