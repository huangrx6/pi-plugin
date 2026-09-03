/**
 * Unit tests for persistence-codec.ts (P3-B.1 envelope encode/decode).
 *
 * Critical invariants tested (P3-B LOCK §25):
 *   1. encode → decode round-trip is identity.
 *   2. Malformed JSON returns DecodeResult.err with kind="corrupt".
 *   3. Valid encoded envelope survives decode.
 *   4. Invalid schemaVersion (non-int) → corrupt.
 *   5. Validate COMPLETE serialized Task shape:
 *      - status must be valid enum value
 *      - archivedAt must be absent or non-negative safe integer
 *      - blockedBy must be absent or array of positive safe integers
 *      - subject must be string
 *      - createdAt/updatedAt must be non-negative safe integers
 *   6. Validation never throws — always returns DecodeResult.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
 CURRENT_SCHEMA_VERSION,
 type PersistedTodoEnvelope,
} from "./persistence-contract.ts";
import {
 decodeEnvelopeFromString,
 encodeEnvelopeToString,
} from "./persistence-codec.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function emptyEnvelope(): PersistedTodoEnvelope<typeof CURRENT_SCHEMA_VERSION> {
 return {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  revision: 0,
  state: { tasks: [], nextId: 1 },
 };
}

function sampleEnvelope(): PersistedTodoEnvelope<
 typeof CURRENT_SCHEMA_VERSION
> {
 return {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  revision: 7,
  state: {
   tasks: [
    {
     id: 1,
     subject: "alpha",
     status: "pending",
     createdAt: 1000,
     updatedAt: 1100,
     blockedBy: [3, 5],
    },
    {
     id: 2,
     subject: "beta",
     status: "completed",
     createdAt: 1200,
     updatedAt: 1300,
     archivedAt: 1400,
    },
   ],
   nextId: 10,
  },
 };
}

// ── A. Encode / decode round-trip ───────────────────────────────────────

describe("persistence-codec: encode/decode round-trip", () => {
 it("★ 1 empty envelope round-trip", () => {
  const env = emptyEnvelope();
  const text = encodeEnvelopeToString(env);
  const decoded = decodeEnvelopeFromString(text);
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok") {
   assert.equal(decoded.envelope.revision, 0);
   assert.deepEqual(decoded.envelope.state.tasks, []);
   assert.equal(decoded.envelope.state.nextId, 1);
  }
 });

 it("★ 2 sample envelope with all optional fields round-trips", () => {
  const env = sampleEnvelope();
  const text = encodeEnvelopeToString(env);
  const decoded = decodeEnvelopeFromString(text);
  assert.equal(decoded.kind, "ok");
  if (decoded.kind === "ok") {
   assert.equal(decoded.envelope.revision, 7);
   assert.equal(decoded.envelope.state.tasks.length, 2);
   const t1 = decoded.envelope.state.tasks[0]!;
   assert.deepEqual(t1.blockedBy, [3, 5]);
   const t2 = decoded.envelope.state.tasks[1]!;
   assert.equal(t2.archivedAt, 1400);
  }
 });
});

// ── B. Malformed JSON ────────────────────────────────────────────────────

describe("persistence-codec: malformed JSON", () => {
 it("★ 3 invalid JSON → DecodeResult.err kind='corrupt'", () => {
  const out = decodeEnvelopeFromString("not valid json{");
  assert.equal(out.kind, "err");
  if (out.kind === "err") {
   assert.equal(out.error.kind, "corrupt");
  }
 });

 it("★ 4 empty string → corrupt", () => {
  const out = decodeEnvelopeFromString("");
  assert.equal(out.kind, "err");
 });

 it("★ 5 JSON null → corrupt (not a valid envelope shape)", () => {
  const out = decodeEnvelopeFromString("null");
  assert.equal(out.kind, "err");
 });
});

// ── C. Structural validation (LOCK §25) ─────────────────────────────────

describe("persistence-codec: structural validation", () => {
 it("★ 6 non-object JSON → corrupt", () => {
  const out = decodeEnvelopeFromString("42");
  assert.equal(out.kind, "err");
 });

 it("★ 7 missing schemaVersion → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({ revision: 0, state: { tasks: [], nextId: 1 } }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 8 schemaVersion is negative → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: -1,
    revision: 0,
    state: { tasks: [], nextId: 1 },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 9 schemaVersion is non-integer → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1.5,
    revision: 0,
    state: { tasks: [], nextId: 1 },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 10 negative revision → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1,
    revision: -1,
    state: { tasks: [], nextId: 1 },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 11 state.tasks not an array → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    state: { tasks: "no", nextId: 1 },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 12 task.status invalid enum → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    state: {
     tasks: [
      { id: 1, subject: "x", status: "invalid", createdAt: 0, updatedAt: 0 },
     ],
     nextId: 1,
    },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 13 task.archivedAt negative → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    state: {
     tasks: [
      {
       id: 1,
       subject: "x",
       status: "completed",
       createdAt: 0,
       updatedAt: 0,
       archivedAt: -5,
      },
     ],
     nextId: 1,
    },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 14 task.blockedBy contains non-integer → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    state: {
     tasks: [
      {
       id: 1,
       subject: "x",
       status: "pending",
       createdAt: 0,
       updatedAt: 0,
       blockedBy: [1.5],
      },
     ],
     nextId: 1,
    },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 15 task.subject non-string → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    state: {
     tasks: [
      { id: 1, subject: 42, status: "pending", createdAt: 0, updatedAt: 0 },
     ],
     nextId: 1,
    },
   }),
  );
  assert.equal(out.kind, "err");
 });

 it("★ 16 state.nextId missing → corrupt", () => {
  const out = decodeEnvelopeFromString(
   JSON.stringify({ schemaVersion: 1, revision: 0, state: { tasks: [] } }),
  );
  assert.equal(out.kind, "err");
 });
});

// ── D. Validation never throws ──────────────────────────────────────────

describe("persistence-codec: total decoder", () => {
 it("★ 17 decoder never throws on any input", () => {
  // Total function: every input returns DecodeResult, never throws.
  const inputs = [
   "",
   "null",
   "[]",
   "42",
   JSON.stringify({}),
   JSON.stringify({
    schemaVersion: "x",
    revision: 0,
    state: { tasks: [], nextId: 1 },
   }),
   JSON.stringify({ schemaVersion: 1, revision: 0, state: null }),
  ];
  for (const input of inputs) {
   const result = decodeEnvelopeFromString(input);
   assert.ok(
    result.kind === "ok" || result.kind === "err",
    "decoder must return DecodeResult",
   );
  }
 });
});
