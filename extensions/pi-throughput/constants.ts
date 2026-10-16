/**
 * 跨模块常量 —— 纯值，无运行时依赖。
 *
 * 调整节流、窗口与宽度上限只改这里。
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

/** 流中状态写入节流（毫秒）：每个 delta 都重绘会抖动且浪费 CPU。 */
export const DEFAULT_THROTTLE_MS = 250;

/**
 * 流中 TPS 的最小分母窗口（毫秒）。
 *
 * provider 把 token 成批 flush 时，几个毫秒对几十个 token 会读出
 * 数千 t/s 的纯量化噪声；窗口不足时先显示占位符，等窗口够了再上数。
 * `message_end` 的终值不受此限制：那时的 token 数与窗口都是精确的。
 */
export const DEFAULT_MIN_WINDOW_MS = 500;

/** 无 provider usage 时的字符 → token 估算比例（保守近似）。 */
export const CONTENT_CHARS_PER_TOKEN = 4;

/** 状态文本宽度上限（终端列）。 */
export const MAX_STATUS_WIDTH = 72;

/** 参与 TTFT / TPS 的流式增量事件类型。 */
export const DELTA_EVENT_TYPES: readonly string[] = [
  "text_delta",
  "thinking_delta",
  "toolcall_delta",
];

// ── 加载占位 ──────────────────────────────────────────────────────────

/** 等待首 token 时的盲文动画帧（与宿主 spinner 同一套字形）。 */
export const LOADING_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** 帧间隔（毫秒）：与宿主 spinner 节奏一致。 */
export const LOADING_INTERVAL_MS = 80;

/** 请求已发出、首 token 未到时的占位文案。 */
export const WAITING_LABEL = "等待首 token…";

/** 已有首 token、但速率窗口未满时的占位文案。 */
export const MEASURING_LABEL = "测速中…";
