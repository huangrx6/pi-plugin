/**
 * Unit tests for persistence-migration.ts (P3-B.2 version migration).
 *
 * Critical invariants tested (P3-A LOCK §7, P3-B LOCK §7):
 *   1. schemaVersion=1 → identity migration (kind="ok", same revision).
 *   2. schemaVersion > CURRENT → unsupported-future.
 *   3. schemaVersion < CURRENT → unsupported-past.
 *   4. Migration preserves revision (no increment).
 *   5. Migration is in-memory only (no durable write side effect).
 *   6. migrationVerdictToError maps unsupported → PersistenceError.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
 CURRENT_SCHEMA_VERSION,
 type PersistedTodoEnvelope,
} from "./persistence-contract.ts";
import {
 migrateToCurrent,
 migrationVerdictToError,
} from "./persistence-migration.ts";

function envelope<V extends number>(
 schemaVersion: V,
 revision = 0,
): PersistedTodoEnvelope<V> {
 return {
  schemaVersion,
  revision,
  state: { tasks: [], nextId: 1 },
 };
}

// ── A. Identity migration (v0 only supports schemaVersion=1) ────────────

describe("persistence-migration: v0 identity migration", () => {
 it("★ 1 schemaVersion=1 → kind='ok', same revision preserved", () => {
  const env = envelope(1, 42);
  const result = migrateToCurrent(env);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
   assert.equal(result.envelope.schemaVersion, CURRENT_SCHEMA_VERSION);
   assert.equal(result.envelope.revision, 42);
   assert.deepEqual(result.envelope.state, { tasks: [], nextId: 1 });
  }
 });

 it("★ 2 schemaVersion=0 → unsupported-past", () => {
  const env = envelope(0);
  const result = migrateToCurrent(env);
  assert.equal(result.kind, "unsupported-past");
  if (result.kind === "unsupported-past") {
   assert.equal(result.foundVersion, 0);
  }
 });

 it("★ 3 schemaVersion=2 → unsupported-future", () => {
  const env = envelope(2);
  const result = migrateToCurrent(env);
  assert.equal(result.kind, "unsupported-future");
  if (result.kind === "unsupported-future") {
   assert.equal(result.foundVersion, 2);
  }
 });

 it("★ 4 schemaVersion=999 (far future) → unsupported-future", () => {
  const env = envelope(999);
  const result = migrateToCurrent(env);
  assert.equal(result.kind, "unsupported-future");
 });
});

// ── B. Revision preservation + no state mutation ────────────────────────

describe("persistence-migration: revision preserved, state untouched", () => {
 it("★ 5 identity migration preserves caller state object reference", () => {
  const state = {
   tasks: [
    {
     id: 1,
     subject: "x",
     status: "pending" as const,
     createdAt: 100,
     updatedAt: 200,
    },
   ],
   nextId: 2,
  };
  const env: PersistedTodoEnvelope<1> = {
   schemaVersion: 1,
   revision: 99,
   state,
  };
  const result = migrateToCurrent(env);
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
   assert.equal(result.envelope.state, state, "state reference preserved");
   assert.equal(result.envelope.revision, 99);
  }
 });
});

// ── C. migrationVerdictToError adapter ──────────────────────────────────

describe("persistence-migration: error adapter", () => {
 it("★ 6 unsupported-future verdict → PersistenceError kind='unsupported-schema'", () => {
  const result = migrateToCurrent(envelope(5));
  assert.notEqual(result.kind, "ok");
  const err = migrationVerdictToError(
   result as Extract<
    typeof result,
    { kind: "unsupported-future" | "unsupported-past" }
   >,
  );
  assert.equal(err.kind, "unsupported-schema");
  assert.equal(err.schemaVersion, 5);
 });

 it("★ 7 unsupported-past verdict → PersistenceError with foundVersion", () => {
  const result = migrateToCurrent(envelope(0));
  const err = migrationVerdictToError(
   result as Extract<
    typeof result,
    { kind: "unsupported-future" | "unsupported-past" }
   >,
  );
  assert.equal(err.kind, "unsupported-schema");
  assert.equal(err.schemaVersion, 0);
 });
});
