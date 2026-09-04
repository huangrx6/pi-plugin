/**
 * Cross-cutting constants — pure values, no runtime deps.
 *
 * Tuning the timing / colors here is safe; everything else stays the same.
 */

// ── Timing ─────────────────────────────────────────────────────────────

export const WIDGET_KEY = "quota";

export const TURN_THROTTLE_MS = 10 * 1000;
export const TREE_THROTTLE_MS = 5 * 1000;
/** How long to keep showing the last good data after a fetch error. */
export const STALE_KEEP_MS = 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;
