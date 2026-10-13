/**
 * Cross-cutting constants — pure values, no runtime deps.
 *
 * Tuning the timing / colors here is safe; everything else stays the same.
 */

// ── Timing ─────────────────────────────────────────────────────────────

export const STATUS_KEY = "pi-quota-status";

export const TURN_THROTTLE_MS = 10 * 1000;
export const TREE_THROTTLE_MS = 5 * 1000;
/** How long to keep showing the last good data after a fetch error. */
export const STALE_KEEP_MS = 60 * 1000;
export const FETCH_TIMEOUT_MS = 15 * 1000;

// ── In-flight placeholder ──────────────────────────────────────────────

/**
 * Braille frames for the placeholder shown while a query is in flight. The
 * same frame set (and cadence) the host spinner uses, so the footer animates
 * in step with the host and only needs the glyphs the host already draws.
 */
export const LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Frame cadence in ms; identical to the host spinner interval. */
export const LOADING_INTERVAL_MS = 80;

/** Label shown beside the frame while the first query is in flight. */
export const LOADING_LABEL = "查询中…";
