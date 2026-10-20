/**
 * 本扩展使用的窄类型。
 *
 * 不 import pi 任何东西：这些结构由宿主事件对象按需窄化而来，
 * 缺字段时一律走安全默认值。
 */

/** TPS 分母口径：stream = 首 token → 结束；e2e = 请求发出 → 结束。 */
export type Measurement = "e2e" | "stream";

/** 状态文本显示哪些指标。 */
export type DisplayMode = "full" | "tps" | "ttft";

/** 单次模型调用的生命周期阶段。 */
export type Phase = "idle" | "waiting" | "streaming" | "done";

export interface ThroughputConfig {
  /** 状态显示总开关；关闭只影响显示，不影响样本记录。 */
  enabled: boolean;
  display: DisplayMode;
  measurement: Measurement;
  /** 是否把每次调用样本与工具用时写入会话。 */
  history: boolean;
  minWindowMs: number;
  throttleMs: number;
}

/** 一次模型调用的记录（写入会话的 custom entry，不含任何回复内容）。 */
export interface ThroughputSample {
  /** 写入时刻（epoch 毫秒），用于会话内排序。 */
  at: number;
  provider: string;
  model: string;
  /** 输出 token：provider usage 权威值，或 chars/N 估算。 */
  tokens: number;
  /** tokens 是否为估算值。 */
  estimated: boolean;
  /** 请求发出 → 首个内容增量；无增量（中断 / 空响应）时为 null。 */
  ttftMs: number | null;
  /** 首个增量 → 消息结束；无增量时为 null。 */
  streamMs: number | null;
  /** 请求发出 → 消息结束。 */
  e2eMs: number;
  /** 用户中断或 provider 报错结束。 */
  aborted: boolean;
}

/** 一次工具执行的时长记录（写入会话的 custom entry，不含参数与结果）。 */
export interface ToolSample {
  /** 写入时刻（epoch 毫秒）。 */
  at: number;
  durationMs: number;
}

/** 流中状态机的只读快照（performance.now 基准）。 */
export interface LiveState {
  phase: Phase;
  provider: string;
  model: string;
  tokens: number;
  estimated: boolean;
  startedAt: number | null;
  firstDeltaAt: number | null;
  endedAt: number | null;
}

// ── 宿主事件对象的窄化形状 ───────────────────────────────────────────

export interface UsageLike {
  output?: number;
}

export interface ContentBlockLike {
  type?: string;
  text?: string;
  thinking?: string;
  arguments?: unknown;
}

export interface AssistantMessageLike {
  role?: string;
  provider?: string;
  model?: string;
  content?: ContentBlockLike[];
  usage?: UsageLike;
  stopReason?: string;
}

export interface AssistantMessageEventLike {
  type?: string;
  partial?: AssistantMessageLike;
}

export interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}
