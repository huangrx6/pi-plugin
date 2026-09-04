/** Quota formatting for the optional status summary and standalone panel. */
import { STALE_KEEP_MS } from "./constants.ts";
import { state as defaultState, type ExtensionState } from "./state.ts";
import type { QuotaBar } from "./types.ts";
import { sanitizeTerminalText, truncateToWidth } from "./ui.ts";

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms)) return ""; // missing reset info — omit suffix
    if (ms < 0) return "reset";
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** Render a single safe, plain-text value. The host theme owns its colors. */
export function formatBar(bar: QuotaBar): string {
    const label = sanitizeTerminalText(bar.label);
    const prefix = label ? `${label} ` : "";
    switch (bar.kind) {
        case "percentage": {
            // Null / non-finite percent (API returns null before first
            // consumption, or an unknown field) renders as a dim "--%"
            // placeholder — never "undefined%" or a misleading "0%".
            const hasPercent =
                bar.percent !== null && Number.isFinite(bar.percent);
            const pct = hasPercent ? `${Math.round(bar.percent * 10) / 10}%` : "--%";
            const reset =
                bar.resetsInMs === undefined ||
                !Number.isFinite(bar.resetsInMs) ||
                formatDuration(bar.resetsInMs) === ""
                    ? ""
                    : ` (${formatDuration(bar.resetsInMs)})`;
            return `${prefix}${pct}${reset}`;
        }
        case "balance":
            // Balance gets neutral dim color — "low balance" isn't a problem
            // signal (could just mean the user hasn't spent much), unlike
            // percentage where higher used = worse. No reset countdown:
            // the value is purely "what's left" with no roll-over moment.
            return `${prefix}${sanitizeTerminalText(bar.currency)}${bar.amount === null || !Number.isFinite(bar.amount) ? "--" : bar.amount.toFixed(2)}`;
        case "text":
            return `${prefix}${sanitizeTerminalText(bar.text)}`;
        default: {
            // Exhaustiveness guard: adding a new QuotaBar kind without
            // updating this switch fails to type-check.
            const _exhaustive: never = bar;
            throw new Error(`unknown bar kind: ${String(_exhaustive)}`);
        }
    }
}

/** Build a compact, plain status contribution; `?` marks stale data. */
export function buildQuotaText(state: ExtensionState = defaultState): string | null {
    if (state.errorText) {
        return truncateToWidth(`! ${state.errorText}`, 72);
    }
    if (!state.quotaData) return null;
    const staleSuffix =
        state.lastRefreshError || (state.quotaFetchedAt > 0 &&
        Date.now() - state.quotaFetchedAt > STALE_KEEP_MS)
            ? " ?"
            : "";
    const elapsed = state.quotaFetchedAt > 0 ? Math.max(0, Date.now() - state.quotaFetchedAt) : 0;
    const parts = state.quotaData.bars.map(bar => formatBar(bar.kind === "percentage" && bar.resetsInMs !== undefined ? { ...bar, resetsInMs: bar.resetsInMs - elapsed } : bar));
    const tag = sanitizeTerminalText(state.quotaData.provider);
    return truncateToWidth(`${tag} ${parts.join(" ")}${staleSuffix}`, 72);
}
