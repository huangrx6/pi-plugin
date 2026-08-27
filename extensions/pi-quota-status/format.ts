/**
 * Quota bar formatting + the buildQuotaText entry point used by renderFooter.
 *
 * `formatBar` dispatches by QuotaBar.kind — adding a new kind requires
 * updating the switch (the `never` guard makes the compiler enforce it).
 *
 * `buildQuotaText` reads from the module-level `state` to produce the
 * colored string the footer renders right-aligned.
 */

import { C, STALE_KEEP_MS } from "./constants.ts";
import { state } from "./state.ts";
import type { QuotaBar } from "./types.ts";

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms)) return ""; // missing reset info — omit suffix
    if (ms < 0) return "reset";
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function colorForPercent(pct: number): string {
    if (pct >= 80) return C.red;
    if (pct >= 50) return C.yellow;
    return C.green;
}

/** Render a single bar to its colored ANSI text. Dispatches by kind. */
export function formatBar(bar: QuotaBar): string {
    switch (bar.kind) {
        case "percentage": {
            // Null / non-finite percent (API returns null before first
            // consumption, or an unknown field) renders as a dim "--%"
            // placeholder — never "undefined%" or a misleading "0%".
            const hasPercent =
                bar.percent !== null && Number.isFinite(bar.percent);
            const color = hasPercent ? colorForPercent(bar.percent) : C.dim;
            const pct = hasPercent ? `${bar.percent}%` : "--%";
            const reset =
                bar.resetsInMs === undefined ||
                !Number.isFinite(bar.resetsInMs) ||
                formatDuration(bar.resetsInMs) === ""
                    ? ""
                    : `${C.dim}(${formatDuration(bar.resetsInMs)})${C.reset}`;
            return `${color}${bar.label}${pct}${C.reset}${reset}`;
        }
        case "balance":
            // Balance gets neutral dim color — "low balance" isn't a problem
            // signal (could just mean the user hasn't spent much), unlike
            // percentage where higher used = worse. No reset countdown:
            // the value is purely "what's left" with no roll-over moment.
            return `${C.dim}${bar.label}${bar.currency}${bar.amount.toFixed(2)}${C.reset}`;
        case "text":
            return `${C.dim}${bar.label}${bar.text}${C.reset}`;
        default: {
            // Exhaustiveness guard: adding a new QuotaBar kind without
            // updating this switch fails to type-check.
            const _exhaustive: never = bar;
            throw new Error(`unknown bar kind: ${String(_exhaustive)}`);
        }
    }
}

/**
 * Build the colored quota text from cached state. Returns null if no
 * quota is active (no provider match / no data yet).
 *
 * Adds a trailing `?` when the data is older than STALE_KEEP_MS so the
 * user knows the displayed numbers might be out of date.
 */
export function buildQuotaText(): string | null {
    if (state.errorText) {
        return `${C.red}${state.errorText}${C.reset}`;
    }
    if (!state.quotaData) return null;
    const staleSuffix =
        state.quotaFetchedAt > 0 &&
        Date.now() - state.quotaFetchedAt > STALE_KEEP_MS
            ? `${C.dim}?${C.reset}`
            : "";
    const parts = state.quotaData.bars.map(formatBar);
    const tag = `${C.dim}${state.quotaData.provider}${C.reset}`;
    return `${tag} ${parts.join(" ")}${staleSuffix}`;
}
