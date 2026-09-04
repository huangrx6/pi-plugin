import type { QuotaData } from "./types.ts";
export type ExtensionState = {
  quotaData: QuotaData | null;
  quotaFetchedAt: number;
  errorText: string;
  lastRefreshError: string;
  loading: boolean;
  lastRefreshAt: number;
  fetchSeq: number;
  /** In-memory digest only; credentials are never persisted or rendered. */
  identity: string;
};
export function createState(): ExtensionState {
  return { quotaData: null, quotaFetchedAt: 0, errorText: "", lastRefreshError: "", loading: false, lastRefreshAt: 0, fetchSeq: 0, identity: "" };
}
/** Default for pure formatting consumers; each running extension owns its state. */
export const state = createState();
