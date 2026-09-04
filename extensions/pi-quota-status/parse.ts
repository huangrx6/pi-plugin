/** Validate external values before computing money or percentages. No Pi imports. */
import type { QuotaBar } from "./types.ts";
export function object(value: unknown, field = "响应"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}数据格式异常`);
  return value as Record<string, unknown>;
}
export function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field}数据格式异常`);
  return value;
}
/** Null means unknown, never zero; numeric suffixes and empty strings are invalid. */
export function number(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`${field}数据格式异常`);
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw new Error(`${field}数据格式异常`);
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${field}数据格式异常`);
  return result;
}
export function percent(value: unknown): number | null {
  const result = number(value, "百分比");
  if (result !== null && (result < 0 || result > 100)) throw new Error("百分比超出 0–100 范围");
  return result;
}
export function resetIn(value: unknown, now: number): number | undefined {
  // Numeric timestamps in these APIs are milliseconds. Do not guess seconds.
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 100_000_000_000 ? at - now : undefined;
}
export function percentBarFromLimitRemaining(detail: unknown, label: string, now: number): QuotaBar {
  const data = object(detail, "套餐");
  const limit = number(data.limit, "套餐上限");
  const remaining = number(data.remaining, "套餐剩余");
  if (limit !== null && limit < 0) throw new Error("套餐上限数据格式异常");
  if (remaining !== null && remaining < 0) throw new Error("套餐剩余数据格式异常");
  if (limit !== null && remaining !== null && remaining > limit) throw new Error("套餐剩余超过上限");
  return { kind: "percentage", label, percent: limit && remaining !== null ? (limit - remaining) / limit * 100 : null, resetsInMs: resetIn(data.resetTime, now) };
}
export function money(label: string, value: unknown, currency: string): QuotaBar {
  return { kind: "balance", label, amount: number(value, "余额"), currency };
}
