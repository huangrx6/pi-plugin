/**
 * file-durable-store.ts — P3-B.4 (real durable backend).
 *
 * File-backed DurableTodoStore. Implements the same interface as
 * the in-memory reference but reads / writes bytes via the codec +
 * migration pipeline. Atomic publication via tmp + rename. ScopeKey
 * identity is preserved by hashing to a deterministic filename
 * (ScopeKey semantics is NOT filesystem path semantics).
 *
 * Concurrency domain: process-local. CAS is serialized within one
 * extension process via per-scope lock. Cross-process CAS is NOT
 * claimed by atomic rename alone; if the host ever spawns multiple
 * writer processes for the same scope, the v0 backend will require
 * explicit inter-process locking (out of scope for P3-B).
 *
 * Module invariants:
 *   1. load reads canonical file (not .tmp staging) — stale tmp
 *      files are ignored and left for explicit cleanup.
 *   2. commit writes to .tmp, then renames to canonical. canonical
 *      is the ONLY durable authority.
 *   3. Snapshot isolation: caller mutation of nextState after commit
 *      or of state after load does NOT alter stored state.
 *   4. rootDir is injected (LOCK §11 — store does not decide its own
 *      root).
 *   5. ScopeKey is hashed (SHA-256) before becoming a filename.
 *   6. Errors thrown by load are PersistenceError values. Errors
 *      during commit that occur AFTER the CAS check leave canonical
 *      state untouched (atomic publication guarantee).
 */

import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
 encodeEnvelopeToString,
 decodeEnvelopeFromString,
} from "./persistence-codec.ts";
import {
 migrateToCurrent,
 migrationVerdictToError,
} from "./persistence-migration.ts";
import {
 CURRENT_SCHEMA_VERSION,
 type CurrentPersistedTodoEnvelope,
 type ScopeKey,
} from "./persistence-contract.ts";
import type { PersistenceError } from "./persistence-error.ts";
import { EMPTY_STATE, type TaskState } from "./types.ts";
import type { CommitResult, DurableTodoStore } from "./durable-store.ts";

// ── Options ─────────────────────────────────────────────────────────────

export interface FileDurableTodoStoreOptions {
 /** Absolute path to a directory used as the durable root. The
  *  directory is created if missing. The store owns files under
  *  this directory; it does NOT traverse or write elsewhere. */
 readonly rootDir: string;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createFileDurableTodoStore(
 options: FileDurableTodoStoreOptions,
): DurableTodoStore {
 const { rootDir } = options;

 // Per-scope in-process lock chain (P3-B LOCK §14).
 const locks = new Map<ScopeKey, Promise<unknown>>();

 async function withLock<T>(scope: ScopeKey, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
   release = r;
  });
  const chained = prev.then(() => next);
  locks.set(scope, chained);
  try {
   return await Promise.resolve(prev).then(fn);
  } finally {
   release();
   if (locks.get(scope) === chained) {
    locks.delete(scope);
   }
  }
 }

 // ── Path derivation ─────────────────────────────────────────────────

 function canonicalPath(scope: ScopeKey): string {
  const hash = createHash("sha256").update(scope).digest("hex");
  return join(rootDir, `${hash}.json`);
 }

 function tmpPath(scope: ScopeKey): string {
  const hash = createHash("sha256").update(scope).digest("hex");
  const nonce = randomBytes(8).toString("hex");
  return join(rootDir, `.${hash}.${nonce}.tmp`);
 }

 // ── Empty envelope materialization ───────────────────────────────────

 function emptyEnvelope(): CurrentPersistedTodoEnvelope {
  return {
   schemaVersion: CURRENT_SCHEMA_VERSION,
   revision: 0,
   state: { ...EMPTY_STATE },
  };
 }

 // ── ENOENT helper ──────────────────────────────────────────────────

 function isENOENT(e: unknown): boolean {
  return (
   typeof e === "object" &&
   e !== null &&
   (e as { code?: unknown }).code === "ENOENT"
  );
 }

 // ── Internal: read + decode + migrate ───────────────────────────────

 async function readCanonical(
  scope: ScopeKey,
 ): Promise<CurrentPersistedTodoEnvelope> {
  const path = canonicalPath(scope);
  let text: string;
  try {
   text = await readFile(path, "utf8");
  } catch (cause) {
   if (isENOENT(cause)) {
    return emptyEnvelope();
   }
   const err: PersistenceError = {
    kind: "io",
    message: "readFile failed",
    cause,
   };
   throw err;
  }

  const decoded = decodeEnvelopeFromString(text);
  if (decoded.kind === "err") {
   throw decoded.error;
  }

  const migrated = migrateToCurrent(decoded.envelope);
  if (migrated.kind !== "ok") {
   throw migrationVerdictToError(migrated);
  }

  // Snapshot isolation: clone before handing back to caller.
  return {
   schemaVersion: migrated.envelope.schemaVersion,
   revision: migrated.envelope.revision,
   state: structuredClone(migrated.envelope.state),
  };
 }

 // ── Public API ───────────────────────────────────────────────────────

 async function load(scope: ScopeKey): Promise<CurrentPersistedTodoEnvelope> {
  // Load is read-only; atomic-rename on the writer side guarantees
  // we read either fully old or fully new (never partial).
  return readCanonical(scope);
 }

 async function commit(
  scope: ScopeKey,
  expectedRevision: number,
  nextState: TaskState,
 ): Promise<CommitResult> {
  return withLock(scope, async () => {
   // Re-read inside lock so the CAS comparison observes the latest
   // committed revision (the only writer that could race is this process).
   const current = await readCanonical(scope);
   if (current.revision !== expectedRevision) {
    return {
     kind: "conflict",
     expectedRevision,
     actualRevision: current.revision,
    };
   }

   const envelope: CurrentPersistedTodoEnvelope = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: expectedRevision + 1,
    state: structuredClone(nextState),
   };

   const canonical = canonicalPath(scope);
   const tmp = tmpPath(scope);

   try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(tmp, encodeEnvelopeToString(envelope), "utf8");
    await rename(tmp, canonical);
   } catch (cause) {
    // Best-effort cleanup; ignore cleanup failure (canonical is unchanged).
    try {
     await unlink(tmp);
    } catch {
     /* ignore */
    }
    const err: PersistenceError = {
     kind: "io",
     message: "atomic publish failed",
     cause,
    };
    throw err;
   }

   return { kind: "committed", envelope };
  });
 }

 return { load, commit };
}
