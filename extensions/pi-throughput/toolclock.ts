/**
 * 工具执行计时器 —— 纯逻辑，时钟可注入，独立可测。
 *
 * 会话口径按**派发 → 结果落地**计时：`tool_execution_start` 覆盖了权限确认
 * 与工具真正执行两段，等价于宿主会话统计的 `tool/call` → `tool/result`。
 * 宿主的 `durationMs` 只覆盖 `execute()`，工具没跑时还会缺省；它只能当兜底。
 */
export interface ToolClock {
  /** 记下一次工具派发（幂等：重复派发以最后一次为准）。 */
  start(callId: string): void;
  /** 结算一次工具调用；没有对应的派发记录时为 null。 */
  end(callId: string): number | null;
  /** 丢弃所有在飞记录（会话替换 / 关闭）。 */
  reset(): void;
}

/**
 * @param now 单调时钟（毫秒）。测试注入假时钟；运行时用 performance.now。
 */
export function createToolClock(now: () => number = () => performance.now()): ToolClock {
  const started = new Map<string, number>();
  return {
    start(callId: string): void {
      started.set(callId, now());
    },

    end(callId: string): number | null {
      const dispatchedAt = started.get(callId);
      if (dispatchedAt === undefined) return null;
      started.delete(callId);
      return Math.max(0, now() - dispatchedAt);
    },

    reset(): void {
      started.clear();
    },
  };
}
