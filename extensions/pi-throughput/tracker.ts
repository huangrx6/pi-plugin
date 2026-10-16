/**
 * 流式计时状态机 —— 纯逻辑，时钟可注入，独立可测。
 *
 * 时间轴：
 *   start()  ──► 首个 *_delta ──► …流式… ──► finish()
 *      │              │                         │
 *      └──── TTFT ────┘                         │
 *      └────────── e2e 时长 ────────────────────┘
 *                     └── stream 时长 ──────────┘
 *
 * 每次模型请求都重新 start()：一轮里的工具循环会发起多次请求，
 * 不重新锚定的话指标会跨调用漂移。
 */
import { DELTA_EVENT_TYPES } from "./constants.ts";
import { tokenCount } from "./format.ts";
import type {
  AssistantMessageEventLike,
  AssistantMessageLike,
  LiveState,
  ThroughputSample,
} from "./types.ts";

export interface TrackerStart {
  provider?: string;
  model?: string;
}

export interface Tracker {
  /** 锚定一次新的模型请求。 */
  start(meta: TrackerStart): void;
  /** 消费一个流式事件；非内容增量会被忽略。 */
  update(event: AssistantMessageEventLike | undefined): void;
  /** 结束当前调用；返回可记录的样本，无事可记时为 null。 */
  finish(message: AssistantMessageLike | undefined): ThroughputSample | null;
  /** 只读快照，供节流渲染读取。 */
  snapshot(): LiveState;
  reset(): void;
}

function idleState(): LiveState {
  return {
    phase: "idle",
    provider: "",
    model: "",
    tokens: 0,
    estimated: false,
    startedAt: null,
    firstDeltaAt: null,
    endedAt: null,
  };
}

/**
 * @param now 单调时钟（毫秒）。测试注入假时钟；运行时用 performance.now。
 */
export function createTracker(now: () => number = () => performance.now()): Tracker {
  let state = idleState();

  return {
    start(meta: TrackerStart): void {
      state = {
        ...idleState(),
        phase: "waiting",
        provider: meta.provider ?? "",
        model: meta.model ?? "",
        startedAt: now(),
      };
    },

    update(event: AssistantMessageEventLike | undefined): void {
      if (!event?.type || !DELTA_EVENT_TYPES.includes(event.type)) return;
      const at = now();
      // finish() 之后的迟到增量不重开测量：那是取消路径上的残留事件。
      if (state.phase === "done" || state.phase === "idle") return;
      if (state.firstDeltaAt === null) {
        state = { ...state, firstDeltaAt: at };
      }
      const count = tokenCount(event.partial);
      state = {
        ...state,
        phase: "streaming",
        tokens: count.tokens,
        estimated: count.estimated,
      };
    },

    finish(message: AssistantMessageLike | undefined): ThroughputSample | null {
      const endedAt = now();
      const previous = state;
      const count = tokenCount(message);
      state = {
        ...previous,
        phase: "done",
        tokens: count.tokens,
        estimated: count.estimated,
        endedAt,
      };
      // 没有 start 就没有可解释的时间轴（例如宿主内部调用）。
      if (previous.startedAt === null) {
        state = idleState();
        return null;
      }
      if (count.tokens <= 0 && previous.firstDeltaAt === null) {
        state = idleState();
        return null;
      }
      return {
        at: Date.now(),
        provider: message?.provider || previous.provider,
        model: message?.model || previous.model,
        tokens: count.tokens,
        estimated: count.estimated,
        ttftMs: previous.firstDeltaAt === null ? null : previous.firstDeltaAt - previous.startedAt,
        streamMs: previous.firstDeltaAt === null ? null : endedAt - previous.firstDeltaAt,
        e2eMs: endedAt - previous.startedAt,
        aborted: message?.stopReason === "aborted" || message?.stopReason === "error",
      };
    },

    snapshot(): LiveState {
      return { ...state };
    },

    reset(): void {
      state = idleState();
    },
  };
}
