/**
 * Cross-cutting constants — pure values, no runtime deps.
 *
 * Tuning the timing / colors here is safe; everything else stays the same.
 */

// ── Timing ─────────────────────────────────────────────────────────────

/** Status kind 前缀 key（与 footer-composer 协议同步，0.3.0+）。 */
export const WIDGET_KEY = "quota:main" as const;
/** 过渡期保留的裸 key：0.3.0 双写、1.0.0 移除。 */
export const LEGACY_WIDGET_KEY = "quota";

export const TURN_THROTTLE_MS = 10 * 1000;
export const TREE_THROTTLE_MS = 5 * 1000;
/** How long to keep showing the last good data after a fetch error. */
export const STALE_KEEP_MS = 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
