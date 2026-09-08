/**
 * cas-retry.test.ts — unit coverage for withCasRetry.
 *
 * The retry semantics are deliberately narrow: only cas-conflict
 * outcomes retry; any other outcome (the attempt's own domain
 * success / failure) short-circuits. These tests pin that
 * contract and the backoff timing so PR2's createMany path can
 * compose with the same helper without losing retry coverage.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { DEFAULT_CAS_RETRY, withCasRetry } from "./cas-retry.ts";

describe("withCasRetry", () => {
 it("returns immediately on first-try success without delay", async () => {
  let calls = 0;
  const result = await withCasRetry<{ tag: string }>(async () => {
   calls++;
   return { kind: "ok", value: { tag: "first" } };
  });
  assert.equal(calls, 1);
  assert.equal(result.kind, "ok");
 });

 it("retries once on conflict then succeeds", async () => {
  let calls = 0;
  const result = await withCasRetry<string>(async () => {
   calls++;
   if (calls === 1) return { kind: "cas-conflict", actualRevision: 7 };
   return { kind: "ok", value: "ok-on-second" };
  });
  assert.equal(calls, 2);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
   assert.equal(result.value, "ok-on-second");
  }
 });

 it("returns last conflict when every attempt conflicts", async () => {
  let calls = 0;
  const result = await withCasRetry<string>(async () => {
   calls++;
   return { kind: "cas-conflict", actualRevision: 10 + calls };
  });
  assert.equal(calls, DEFAULT_CAS_RETRY.maxAttempts);
  assert.equal(result.kind, "cas-conflict");
  if (result.kind === "cas-conflict") {
   // Default maxAttempts is 8, so last attempt yields actualRevision = 10 + 8 = 18.
   assert.equal(result.actualRevision, 18);
  }
 });

 it("does not retry on non-conflict outcomes", async () => {
  let calls = 0;
  // Simulate a domain outcome that the caller chooses to model
  // as `ok` (e.g. reducer-level validation error returned as a
  // final result rather than a throw). The helper must treat
  // `ok` as terminal regardless of its inner payload.
  const result = await withCasRetry<{ reason: string }>(async () => {
   calls++;
   return { kind: "ok", value: { reason: "bad input" } };
  });
  assert.equal(calls, 1);
  assert.equal(result.kind, "ok");
 });

 it("respects maxAttempts override", async () => {
  let calls = 0;
  const result = await withCasRetry<string>(
   async () => {
    calls++;
    return { kind: "cas-conflict", actualRevision: 99 };
   },
   { maxAttempts: 5 },
  );
  assert.equal(calls, 5);
  assert.equal(result.kind, "cas-conflict");
  if (result.kind === "cas-conflict") {
   assert.equal(result.actualRevision, 99);
  }
 });

 it("respects custom delayMs schedule", async () => {
  const stamps: number[] = [];
  const start = Date.now();
  let calls = 0;
  await withCasRetry<string>(
   async () => {
    stamps.push(Date.now() - start);
    calls++;
    return { kind: "cas-conflict", actualRevision: calls };
   },
   { maxAttempts: 3, delayMs: () => 25 },
  );
  assert.equal(calls, 3);
  // Two waits of 25ms each — generous lower bound to absorb scheduler jitter.
  assert.ok(stamps[1]! >= 24, `attempt 1 should wait ~25ms, got ${stamps[1]}`);
  assert.ok(
   stamps[2]! >= 49,
   `attempt 2 should wait ~50ms cumulative, got ${stamps[2]}`,
  );
 });

 it("applies default linear backoff (30ms then 60ms)", async () => {
  const stamps: number[] = [];
  const start = Date.now();
  let calls = 0;
  await withCasRetry<string>(async () => {
   stamps.push(Date.now() - start);
   calls++;
   return { kind: "cas-conflict", actualRevision: calls };
  });
  assert.equal(calls, DEFAULT_CAS_RETRY.maxAttempts);
  assert.ok(stamps[1]! >= 29, `attempt 1 should wait ≥30ms, got ${stamps[1]}`);
  assert.ok(
   stamps[2]! >= 89,
   `attempt 2 should wait ≥90ms cumulative, got ${stamps[2]}`,
  );
 });

 it("preserves attempt-thrown errors verbatim (does not swallow)", async () => {
  // Sanity: withCasRetry does not promise to retry thrown errors.
  // A thrown attempt must surface immediately so domain bugs aren't
  // masked by silent retry.
  await assert.rejects(
   () =>
    withCasRetry<string>(async () => {
     throw new Error("attempt exploded");
    }),
   /attempt exploded/,
  );
 });

 it("returns zero-revision fallback when no attempt ever ran (maxAttempts<=0)", async () => {
  // Defensive: if a caller wires maxAttempts: 0, we return a
  // synthetic conflict rather than undefined. The actualRevision
  // is meaningless but the shape is stable for callers.
  const result = await withCasRetry<string>(
   async () => {
    throw new Error("should not be called");
   },
   { maxAttempts: 0 },
  );
  assert.equal(result.kind, "cas-conflict");
  if (result.kind === "cas-conflict") {
   assert.equal(result.actualRevision, 0);
  }
 });
});
