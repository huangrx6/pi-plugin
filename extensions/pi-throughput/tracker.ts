/**
 * 流式计时状态机 —— 纯逻辑，时钟可注入，独立可测。
 *
 * TTFT 从请求到首个非空内容增量（含思考）。
 * stream 从首个正文或工具参数增量到结束；e2e 从请求到结束。
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
  let firstOutputAt: number | null = null;
  let sawThinking = false;

  return {
    start(meta: TrackerStart): void {
      firstOutputAt = null;
      sawThinking = false;
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
      const count = tokenCount(event.partial);
      // 首 token 只认非空增量：provider 有时先发
      // 一个空 delta 开流，把它当首 token 会把 TTFT 算成接近 0。
      const delta = event.delta;
      const carriesContent = typeof delta === "string" ? delta.length > 0 : count.tokens > 0;
      if (!carriesContent) return;
      if (event.type === "thinking_delta") sawThinking = true;
      else firstOutputAt ??= at;
      state = {
        ...state,
        phase: "streaming",
        firstDeltaAt: state.firstDeltaAt ?? at,
        tokens: count.tokens,
        estimated: count.estimated,
      };
    },

    finish(message: AssistantMessageLike | undefined): ThroughputSample | null {
      const endedAt = now();
      const previous = state;
      // 一个请求只结算一次；迟到或重复的 message_end 不重复计入。
      if (previous.startedAt === null || previous.phase === "done") return null;
      const count = tokenCount(message);
      state = {
        ...previous,
        phase: "done",
        tokens: count.tokens,
        estimated: count.estimated,
        endedAt,
      };
      // 隐藏推理不一定产生增量，不能把它的 token 除以正文传输窗口。
      // 有思考内容但未上报可用拆分（包括 reasoning=0）时，宁缺不估。
      const hasThinking = sawThinking || message?.content?.some(block => block.type === "thinking");
      const reasoning = message?.usage?.reasoning;
      const knownReasoning = typeof reasoning === "number" && Number.isFinite(reasoning) &&
        reasoning >= 0 && reasoning <= count.tokens;
      const streamTokens = count.estimated || (reasoning !== undefined && !knownReasoning) ||
        (hasThinking && (!knownReasoning || reasoning === 0))
        ? null : knownReasoning ? count.tokens - reasoning : count.tokens;
      return {
        at: Date.now(),
        provider: message?.provider || previous.provider,
        model: message?.model || previous.model,
        tokens: count.tokens,
        streamTokens,
        estimated: count.estimated,
        ttftMs: previous.firstDeltaAt === null ? null : previous.firstDeltaAt - previous.startedAt,
        streamMs: firstOutputAt === null ? null : endedAt - firstOutputAt,
        e2eMs: endedAt - previous.startedAt,
        aborted: message?.stopReason === "aborted" || message?.stopReason === "error",
      };
    },

    snapshot(): LiveState {
      return { ...state };
    },

    reset(): void {
      state = idleState();
      firstOutputAt = null;
      sawThinking = false;
    },
  };
}
