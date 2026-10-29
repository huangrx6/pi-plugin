import type { Snapshot, Usage } from "./types.ts";
/** Streaming is a disposable projection: never append estimates to history. */
export function createLiveUsage() {
  let units = 0, usage: Usage | undefined, active = false;
  const reset = () => { units = 0; usage = undefined; active = false; };
  return {
    reset,
    start() { reset(); active = true; },
    update(event?: { type?: string; delta?: unknown }, nextUsage?: Usage) {
      active = true;
      if (nextUsage) usage = nextUsage;
      if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event?.type ?? "") && typeof event?.delta === "string") {
        // Approximation only: CJK ≈ one token/character, other text ≈ four characters/token.
        for (const char of event.delta) units += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 1 : .25;
      }
    },
    project(base: Snapshot, timing: { elapsedMs: number; generationMs: number | null } | null): Snapshot {
      if (!active || !timing) return base;
      const positive = (n: unknown): number => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
      const reported = positive(usage?.output), output = reported || Math.ceil(units);
      const estimated = !reported;
      const current = { input: positive(usage?.input), output, cacheRead: positive(usage?.cacheRead), cacheWrite: positive(usage?.cacheWrite), cost: positive(usage?.cost?.total) };
      const input = current.input + current.cacheRead + current.cacheWrite;
      const contextTokens = input > 0 ? input + output : base.context?.tokens == null ? null : base.context.tokens + output;
      return { ...base, steps: base.steps + 1,
        usage: Object.fromEntries(Object.entries(base.usage).map(([key, value]) => [key, value + current[key as keyof typeof current]])) as Snapshot["usage"],
        context: base.context ? { ...base.context, tokens: contextTokens, percent: contextTokens === null ? null : contextTokens / base.context.contextWindow * 100 } : null,
        live: { estimated, elapsedMs: timing.elapsedMs,
          rate: output > 0 && timing.generationMs !== null && timing.generationMs >= 500 ? output / timing.generationMs * 1000 : null },
      };
    },
  };
}
