// Recognition preflight tuning across heterogeneous model catalogues.
//
// The preflight asks the ACTIVE host model for one small validated JSON
// object. What varies wildly across providers is the THINKING bill:
// deep server-side reasoning can exceed any reasonable deadline, and
// the parameter that throttles it differs per provider. This module
// picks the right control for the model at hand, in three layers:
//
//   1. adapter-mediated models (compat.thinkingFormat: zai / qwen /
//      deepseek / openrouter / string-thinking / together / …):
//      pi-ai's openai-completions adapter DISABLES thinking whenever
//      the caller passes no `reasoningEffort`. We intentionally pass
//      nothing — the adapter sends the provider's off switch.
//
//   2. OpenAI-style `reasoning_effort` models (no thinkingFormat, but
//      compat.supportsReasoningEffort and model.reasoning): we pass
//      `reasoningEffort: "low"` — the adapter sends the mapped or raw
//      effort, a bounded-reasoning request instead of the server
//      default.
//
//   3. uncontrolled-reasoning providers (no thinkingFormat, no
//      reasoning-effort support — e.g. Volcengine Ark, whose
//      server-side thinking defaults on and receives no switch at
//      all): a small VERIFIED table of request-body patches keyed by
//      provider id / baseUrl. Unknown providers stay untouched —
//      strict servers may reject unknown fields, so the table only
//      grows with verified entries.
//
// Everything here is advisory: the caller merges the user's
// `recognition.requestBody` LAST, so explicit configuration always
// wins, and `recognition.autoTuning: false` disables the whole layer.

const LOW_EFFORT = "low";

/** Verified request-body thinking-off patches. Only add entries that
 *  have been verified against the live provider — unknown fields can
 *  400 on strict servers. */
const THINKING_OFF_PATCHES = [
  {
    note: "volcengine-ark:thinking-disabled",
    providers: ["volcengine-coding", "volcengine"],
    baseUrlIncludes: ["volces.com"],
    patch: { thinking: { type: "disabled" } },
  },
];

/**
 * Decide the recognition-call tuning for one model.
 *
 * @param {unknown} modelLike the host Model object (provider / id /
 *   api / baseUrl / reasoning / compat are read defensively).
 * @param {{ auto?: boolean }} [options] `auto: false` returns null
 *   (kill switch for the whole layer).
 * @returns {{ reasoningEffort?: string, samplingPatch?: object, note: string } | null}
 */
export function planRecognitionTuning(modelLike, options = {}) {
  if (options.auto === false) return null;
  const model = modelLike && typeof modelLike === "object" ? modelLike : null;
  if (!model) return null;

  // Non-reasoning models need no thinking control at all.
  if (model.reasoning === false) {
    return { note: "non-reasoning-model" };
  }

  const compat = model.compat ?? {};
  const api = typeof model.api === "string" ? model.api : undefined;

  // Layer 1: adapter-mediated thinking. Passing no reasoningEffort is
  // the switch itself for every thinkingFormat provider.
  if (compat.thinkingFormat) {
    return { note: `adapter-mediated:${compat.thinkingFormat}` };
  }

  // Layer 2: OpenAI-style bounded effort. Only for the
  // openai-completions transport where the adapter forwards
  // reasoningEffort verbatim (or via thinkingLevelMap).
  if (compat.supportsReasoningEffort && api !== "anthropic-messages") {
    return { reasoningEffort: LOW_EFFORT, note: "reasoning-effort:low" };
  }

  // Layer 3: verified provider table for uncontrolled reasoning.
  const provider = String(model.provider ?? "").toLowerCase();
  const baseUrl = String(model.baseUrl ?? "").toLowerCase();
  for (const entry of THINKING_OFF_PATCHES) {
    if (
      entry.providers.includes(provider) ||
      entry.baseUrlIncludes.some((fragment) => baseUrl.includes(fragment))
    ) {
      return { samplingPatch: entry.patch, note: entry.note };
    }
  }

  // Uncontrolled reasoning on an unknown provider: no safe automatic
  // switch exists. The user's requestBody / onFailure remain the
  // escape hatches; say so in the diagnostics.
  return { note: "uncontrolled-reasoning" };
}
