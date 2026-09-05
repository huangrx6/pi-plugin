/**
 * persistence-codec.ts — P3-B.1 (envelope bytes ↔ typed envelope).
 *
 * Strict schema boundary: no unchecked JSON cast. Every decoded
 * value passes through runtime validation of the COMPLETE serialized
 * Task / TaskState / PersistedTodoEnvelope shape (P3-B LOCK §25)
 * before being typed.
 *
 * Domain repair / cross-field inference is FORBIDDEN. Validation
 * confirms that the typed claim "unknown → TaskState" actually holds
 * at the persistence-schema level.
 *
 * Module invariants:
 *   1. Encode / decode are deterministic (pure functions of input).
 *   2. Validation covers ALL fields required by the TaskState
 *      type, including optional fields and enum / discriminant
 *      values (status ∈ "pending" | "in_progress" | "completed"
 *      | "deleted"; archivedAt / closedAt absent-or-number; blockedBy absent-or-
 *      number[]).
 *   3. Validation failures yield PersistenceError (corrupt / io),
 *      NOT user-facing UX strings.
 *   4. Decoder is total over byte sequences: malformed bytes return
 *      DecodeResult.err, never throw.
 */

import type { PersistenceError } from "./persistence-error.ts";
import type { PersistedTodoEnvelope } from "./persistence-contract.ts";
import { CURRENT_SCHEMA_VERSION } from "./persistence-contract.ts";

// ── Encode ─────────────────────────────────────────────────────────────

/** Serialize a typed envelope to a JSON string. No validation. */
export function encodeEnvelopeToString(
 envelope: PersistedTodoEnvelope,
): string {
 return JSON.stringify(envelope);
}

// ── Decode ─────────────────────────────────────────────────────────────

export type DecodeResult =
 | { readonly kind: "ok"; readonly envelope: PersistedTodoEnvelope<number> }
 | { readonly kind: "err"; readonly error: PersistenceError };

/**
 * Parse + structurally validate a JSON string into a typed envelope.
 * Never throws. Always returns DecodeResult.
 */
export function decodeEnvelopeFromString(text: string): DecodeResult {
 let raw: unknown;
 try {
  raw = JSON.parse(text);
 } catch (cause) {
  return {
   kind: "err",
   error: {
    kind: "corrupt",
    message: "JSON.parse failed",
    cause,
   },
  };
 }
 const validation = validateEnvelope(raw);
 return validation;
}

// ── Structural validation (P3-B LOCK §25) ───────────────────────────────
//
// These checks confirm the serialized representation conforms to the
// TypeScript TaskState / Task / PersistedTodoEnvelope shapes. They
// perform no cross-field or domain inference.

function isObject(x: unknown): x is Record<string, unknown> {
 return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isPositiveSafeInteger(x: unknown): x is number {
 return typeof x === "number" && Number.isSafeInteger(x) && x > 0;
}

function isNonNegativeSafeInteger(x: unknown): x is number {
 return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

const VALID_STATUS = new Set([
 "pending",
 "in_progress",
 "completed",
 "deleted",
]);

function validateEnvelope(raw: unknown): DecodeResult {
 if (!isObject(raw)) {
  return {
   kind: "err",
   error: { kind: "corrupt", message: "envelope is not an object" },
  };
 }

 const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
 if (!isPositiveSafeInteger(schemaVersion)) {
  return {
   kind: "err",
   error: {
    kind: "corrupt",
    message: "schemaVersion is not a positive safe integer",
   },
  };
 }

 const revision = (raw as { revision?: unknown }).revision;
 if (!isNonNegativeSafeInteger(revision)) {
  return {
   kind: "err",
   error: {
    kind: "corrupt",
    message: "revision is not a non-negative safe integer",
   },
  };
 }

 const state = (raw as { state?: unknown }).state;
 const stateErr = validateTaskState(state);
 if (stateErr) {
  return { kind: "err", error: stateErr };
 }

 return {
  kind: "ok",
  envelope: {
   schemaVersion: schemaVersion as number,
   revision: revision as number,
   state: state as PersistedTodoEnvelope["state"],
  },
 };
}

function validateTaskState(raw: unknown): PersistenceError | null {
 if (!isObject(raw)) {
  return { kind: "corrupt", message: "state is not an object" };
 }
 const tasks = (raw as { tasks?: unknown }).tasks;
 if (!Array.isArray(tasks)) {
  return { kind: "corrupt", message: "state.tasks is not an array" };
 }
 for (let i = 0; i < tasks.length; i++) {
  const err = validateTask(tasks[i], `tasks[${i}]`);
  if (err) return err;
 }
 const nextId = (raw as { nextId?: unknown }).nextId;
 if (!isPositiveSafeInteger(nextId)) {
  return {
   kind: "corrupt",
   message: "state.nextId is not a positive safe integer",
  };
 }
 return null;
}

function validateTask(raw: unknown, path: string): PersistenceError | null {
 if (!isObject(raw)) {
  return { kind: "corrupt", message: `${path} is not an object` };
 }
 const t = raw as {
  id?: unknown;
  subject?: unknown;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archivedAt?: unknown;
  closedAt?: unknown;
  closedReason?: unknown;
  blockedBy?: unknown;
 };

 if (!isPositiveSafeInteger(t.id)) {
  return {
   kind: "corrupt",
   message: `${path}.id is not a positive safe integer`,
  };
 }
 if (typeof t.subject !== "string") {
  return {
   kind: "corrupt",
   message: `${path}.subject is not a string`,
  };
 }
 if (typeof t.status !== "string" || !VALID_STATUS.has(t.status)) {
  return {
   kind: "corrupt",
   message: `${path}.status is not a valid status enum value`,
  };
 }
 if (!isNonNegativeSafeInteger(t.createdAt)) {
  return {
   kind: "corrupt",
   message: `${path}.createdAt is not a non-negative safe integer`,
  };
 }
 if (!isNonNegativeSafeInteger(t.updatedAt)) {
  return {
   kind: "corrupt",
   message: `${path}.updatedAt is not a non-negative safe integer`,
  };
 }
 if (t.archivedAt !== undefined && !isNonNegativeSafeInteger(t.archivedAt)) {
  return {
   kind: "corrupt",
   message: `${path}.archivedAt is present but not a non-negative safe integer`,
  };
 }
 if (t.closedAt !== undefined && !isNonNegativeSafeInteger(t.closedAt)) {
  return {
   kind: "corrupt",
   message: `${path}.closedAt is present but not a non-negative safe integer`,
  };
 }
 if (t.closedReason !== undefined && typeof t.closedReason !== "string") {
  return {
   kind: "corrupt",
   message: `${path}.closedReason is present but not a string`,
  };
 }
 if (t.blockedBy !== undefined) {
  if (!Array.isArray(t.blockedBy)) {
   return {
    kind: "corrupt",
    message: `${path}.blockedBy is present but not an array`,
   };
  }
  for (let j = 0; j < t.blockedBy.length; j++) {
   if (!isPositiveSafeInteger(t.blockedBy[j])) {
    return {
     kind: "corrupt",
     message: `${path}.blockedBy[${j}] is not a positive safe integer`,
    };
   }
  }
 }
 return null;
}

/** Re-export CURRENT_SCHEMA_VERSION for callers that decode envelopes. */
export { CURRENT_SCHEMA_VERSION };
