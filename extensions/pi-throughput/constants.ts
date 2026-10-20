/**
 * 跨模块常量 —— 纯值，无运行时依赖。
 *
 * 调整节流与宽度上限只改这里。
 */

export const PACKAGE_NAME = "pi-throughput";

/**
 * Pi 状态集合里的发布 key：与扩展同名。
 *
 * 状态只以纯文本发布一次，任何按 key 读取 Pi 状态集合的底栏渲染器
 * 都可以显示它；本扩展不假设、也不关心底栏由谁绘制。
 */
export const STATUS_KEY = PACKAGE_NAME;

/** 会话内样本 entry 的 customType；不进入 LLM context。 */
export const SAMPLE_TYPE = "pi-throughput-sample";

/** 会话内工具用时 entry 的 customType；与模型调用样本分开记。 */
export const TOOL_SAMPLE_TYPE = "pi-throughput-tool";

/** 流中状态写入节流（毫秒）：每个 delta 都重绘会抖动且浪费 CPU。 */
export const DEFAULT_THROTTLE_MS = 250;

/** 无 provider usage 时只记录字符估算值；估算不进入任何速率。 */
export const CJK_TOKENS_PER_CHAR = 1;

export const OTHER_CHARS_PER_TOKEN = 3.5;

/** 状态文本宽度上限（终端列）。 */
export const MAX_STATUS_WIDTH = 72;

/** 参与 TTFT / TPS 的流式增量事件类型。 */
export const DELTA_EVENT_TYPES: readonly string[] = [
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
];

// ── 等待计时 ──────────────────────────────────────────────────────────

/**
 * 「等待首 token」计时刷新间隔（毫秒）。
 *
 * 等待期只刷新数字（`等待 3.2s`），不跑盲文动画帧：帧看起来像又
 * 一个 spinner，数字变化才是这件事本身的信息。
 */
export const WAIT_TICK_MS = 200;
