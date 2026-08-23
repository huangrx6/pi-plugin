/**
 * Module-level mutable state shared across the event handlers, refresh
 * logic, and footer renderer. Kept in a single object so a deep debugger
 * can see all extension state at one stop.
 *
 * Three groups:
 *   - Quota display state (read by buildQuotaText in format.ts)
 *   - Footer lifecycle state (the currently-mounted footer closure)
 *   - Refresh guards (throttle timestamp + sequence number)
 *
 * Mutated directly by events / refreshQuota in index.ts. Read by
 * buildQuotaText (format.ts) and the renderFooter closure (render.ts).
 *
 * No setters/getters — direct property mutation is fine because the
 * module is single-instance (pi loads the extension exactly once).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { QuotaCtx, QuotaData } from "./types.ts";

type ExtensionState = {
 // Quota display
 quotaData: QuotaData | null;
 quotaFetchedAt: number;
 errorText: string;

 // Footer lifecycle
 activeFooterCtx: QuotaCtx | null;
 // ModelLikeShape is `{...} | null` (from globals.d.ts); using `| null`
 // (not `| undefined`) keeps the state-side type compatible with
 // renderFooter's `ExtensionContext["model"] | undefined` parameter
 // — null is in ModelLikeShape, undefined is added at the function
 // boundary, so the assignability is clean in both directions.
 activeModel: ExtensionContext["model"] | null;
 activeThinkingLevel: ExtensionContext["thinkingLevel"] | null;
 requestFooterRender: (() => void) | null;

 // Refresh guards
 lastRefreshAt: number;
 fetchSeq: number;
};

export const state: ExtensionState = {
 quotaData: null,
 quotaFetchedAt: 0,
 errorText: "",
 activeFooterCtx: null,
 activeModel: null,
 activeThinkingLevel: null,
 requestFooterRender: null,
 lastRefreshAt: 0,
 fetchSeq: 0,
};
