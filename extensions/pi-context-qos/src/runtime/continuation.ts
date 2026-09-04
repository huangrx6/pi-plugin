/** Owns only compactions requested by this extension, never manual /compact. */
export interface ContinuationContext {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getSystemPrompt?(): string;
  signal?: AbortSignal;
  sessionManager: { getSessionId(): string };
  compact(options: {
    customInstructions: string;
    onComplete(result: { tokensBefore: number; estimatedTokensAfter?: number }): void;
    onError(error: Error): void;
  }): void;
}

export interface CompactionNotice {
  readonly status: "resumed" | "completed" | "failed";
  readonly text: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
}

/** Preserve complete changed lines without copying the unchanged base prompt. */
export function changedInstructions(active: string, base: string): string {
  const before = active.split("\n");
  const after = base.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length;
  let baseEnd = after.length;
  while (end > start && baseEnd > start && before[end - 1] === after[baseEnd - 1]) { end--; baseEnd--; }
  return before.slice(start, end).join("\n").trim();
}

export class CompactionContinuation {
  private generation = 0;
  private pending: object | undefined;
  private attempted = false;
  private continuationPrompt: string | undefined;

  constructor(
    private readonly resume: (objective: string, activeInstructions: string) => void,
    private readonly notice: (notice: CompactionNotice) => void,
  ) {}

  private publishNotice(notice: CompactionNotice): void {
    // The same object is stored in session history and exposed in the current
    // command panel. Freezing prevents later runtime changes from rewriting an
    // already-recorded explanation.
    this.notice(Object.freeze({ ...notice }));
  }

  /** User input, branch/session changes and shutdown invalidate old callbacks. */
  invalidate(): void {
    this.generation++;
    this.pending = undefined;
    this.attempted = false;
    this.continuationPrompt = undefined;
  }

  observePressure(overBudget: boolean): void {
    // A successful request must actually get below the threshold before it can
    // compact again. Failed/no-op compactions cannot cause a continuation loop.
    if (!overBudget && !this.pending) this.attempted = false;
  }

  request(ctx: ContinuationContext, objective: string, basePrompt?: string): boolean {
    if (this.pending || this.attempted || ctx.signal?.aborted ||
        ctx.isIdle() || ctx.hasPendingMessages()) return false;
    this.attempted = true;
    const token = {};
    this.pending = token;
    const generation = this.generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const activePrompt = this.continuationPrompt ?? ctx.getSystemPrompt?.() ?? "";
    const current = () => this.pending === token && generation === this.generation &&
      ctx.sessionManager.getSessionId() === sessionId;
    const onError = (error: Error) => {
      if (!current()) return;
      this.pending = undefined;
      this.publishNotice({ status: "failed", text: `上下文整理未完成：${error.message}。未自动重试；可查看 /context。` });
    };
    try {
      ctx.compact({
        customInstructions: "Preserve the current user objective, explicit constraints, unresolved evidence, modified files, decisions, and ctx:// recall references. Identify the next unfinished step and distinguish completed operations from pending ones.",
        onComplete: result => {
          if (!current()) return;
          this.pending = undefined;
          const resume = ctx.isIdle() && !ctx.hasPendingMessages();
          if (resume) {
            this.continuationPrompt = activePrompt;
            this.resume(objective, changedInstructions(activePrompt, basePrompt ?? ""));
          }
          this.publishNotice({
            status: resume ? "resumed" : "completed",
            text: resume ? "上下文已整理，已请求继续当前任务。" : "上下文已整理，优先处理当前运行或新指令。",
            tokensBefore: result.tokensBefore,
            tokensAfter: result.estimatedTokensAfter,
          });
        },
        onError,
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }
}
