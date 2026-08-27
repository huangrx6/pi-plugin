/**
 * Module-level mutable state shared across the event handlers and refresh
 * logic. Kept in a single object so a deep debugger can see all extension
 * state at one stop.
 *
 * Two groups:
 *   - Quota display state (read by buildQuotaText in format.ts)
 *   - Refresh guards (throttle timestamp + sequence number)
 *
 * Mutated directly by events / refreshQuota in index.ts. Read by
 * buildQuotaText (format.ts).
 *
 * No setters/getters — direct property mutation is fine because the
 * module is single-instance (pi loads the extension exactly once).
 */

import type { QuotaData } from "./types.ts";

type ExtensionState = {
  // Quota display
  quotaData: QuotaData | null;
  quotaFetchedAt: number;
  errorText: string;

  // Refresh guards
  lastRefreshAt: number;
  fetchSeq: number;
};

export const state: ExtensionState = {
  quotaData: null,
  quotaFetchedAt: 0,
  errorText: "",
  lastRefreshAt: 0,
  fetchSeq: 0,
};
