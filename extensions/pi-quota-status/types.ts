/** Model names never identify the billing account. */
export type ModelLike = { provider?: string; id?: string; baseUrl?: string } | undefined | null;
export type QuotaBar =
  | { readonly kind: "percentage"; readonly label: string; readonly percent: number | null; readonly resetsInMs?: number }
  | { readonly kind: "balance"; readonly label: string; readonly amount: number | null; readonly currency: string }
  | { readonly kind: "text"; readonly label: string; readonly text: string };
export type QuotaData = { readonly provider: string; readonly bars: readonly QuotaBar[] };
export interface QuotaAdapter {
  readonly display: string;
  readonly title: string;
  readonly category: "套餐用量" | "账户余额" | "密钥额度";
  readonly providerNames: readonly string[];
  readonly apiKeyEnvVar: string;
  readonly apiKeyEnvVarAliases?: readonly string[];
  readonly endpoint: string;
  readonly modelHosts: readonly string[];
  readonly note: string;
  readonly fetch: (apiKey: string, signal?: AbortSignal) => Promise<readonly QuotaBar[]>;
}
