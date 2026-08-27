/**
 * All TypeScript types used across the extension. No runtime code —
 * importing this file pulls in zero JS.
 *
 * Sections:
 *   - Model slice:        ModelLike (provider/id — all refresh reads)
 *   - Quota data model:   QuotaBar (discriminated union) / QuotaData
 *   - Adapter contract:   QuotaAdapter
 */

/** Provider/id slice of pi's Model — the only shape refresh logic reads. */
export type ModelLike = { provider?: string; id?: string } | undefined | null;

// ── Quota data model ──────────────────────────────────────────────────

/**
 * A single bar in the quota footer. The `kind` field is the discriminator:
 *
 *   - `percentage`: rolling-window subscription (OpenCode Go / Zhipu GLM /
 *     MiniMax Token Plan / Kimi Code). `percent` is **used** percentage
 *     (higher = worse); `null` means the API reported no value yet
 *     (renders as a dim `--%` placeholder, never as a misleading 0%).
 *     Optional `resetsInMs` drives the `(2h28m)` suffix (non-finite →
 *     suffix omitted).
 *   - `balance`: prepaid / remaining-credit provider (DeepSeek / OpenRouter).
 *     `amount` is the remaining quantity in `currency` units; no reset
 *     countdown because the value is purely "what's left".
 *   - `text`: escape hatch for any provider whose quantity isn't a clean
 *     number — render as-is in dim.
 *
 * Adapters always build `percentage` for rolling-window cases so the
 * existing `colorForPercent` thresholds apply uniformly across providers.
 */
export type QuotaBar =
  | {
      readonly kind: "percentage";
      readonly label: string;
      readonly percent: number | null;
      readonly resetsInMs?: number;
    }
  | {
      readonly kind: "balance";
      readonly label: string;
      readonly amount: number;
      readonly currency: string;
    }
  | { readonly kind: "text"; readonly label: string; readonly text: string };

/** Module-level state shape (provider tag + rendered bars). */
export type QuotaData = {
  readonly provider: string;
  readonly bars: readonly QuotaBar[];
};

// ── Adapter contract ──────────────────────────────────────────────────

/**
 * Self-contained provider entry — see ADAPTERS registry in adapters.ts.
 *
 * Adding a new subscription = add one entry; nothing else changes.
 */
export interface QuotaAdapter {
  /** Footer tag, e.g. "⚡OC". */
  readonly display: string;
  /** Pi provider-name aliases (e.g. "opencode-go" + custom names). */
  readonly providerNames: readonly string[];
  /**
   * Primary env var name (aligned with pi-coding-agent's official
   * convention for this provider, so users can set ONE env var that
   * both pi and this extension read from).
   */
  readonly apiKeyEnvVar: string;
  /**
   * Additional env var names to try if `apiKeyEnvVar` is unset.
   * Used for backward compat with users who set a different env var
   * name (e.g. `ZAI_API_KEY` vs pi's official `ZAI_CODING_CN_API_KEY`).
   */
  readonly apiKeyEnvVarAliases?: readonly string[];
  /** API URL. Mirror of ENDPOINTS[id] for introspection. */
  readonly endpoint: string;
  /** Fetch + parse into a flat bar list. The framework attaches `display`. */
  readonly fetch: (apiKey: string) => Promise<readonly QuotaBar[]>;
}
