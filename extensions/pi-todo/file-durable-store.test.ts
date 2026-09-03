/**
 * Integration tests for file-durable-store.ts (P3-B.4 real backend).
 *
 * Exercises the full persisted-byte pipeline:
 *   bytes → decode → migrate → envelope
 *   envelope → encode → atomic publish (tmp + rename)
 *
 * Each test gets an isolated tmp directory via mkdtemp.
 *
 * Coverage:
 *   A. Load (4 tests)
 *   B. Commit (5 tests)
 *   C. Restart / atomicity / stale tmp (3 tests)
 *   D. Architecture (3 tests)
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
 CURRENT_SCHEMA_VERSION,
 type ScopeKey,
} from "./persistence-contract.ts";
import type { TaskState } from "./types.ts";
import { createFileDurableTodoStore } from "./file-durable-store.ts";
import type { DurableTodoStore } from "./durable-store.ts";

const SCOPE_A = "scope-a" as ScopeKey;
const SCOPE_B = "scope-b" as ScopeKey;

function emptyState(): TaskState {
 return { tasks: [], nextId: 1 };
}

function stateWith(id: number, subject = `task ${id}`): TaskState {
 return {
  tasks: [
   {
    id,
    subject,
    status: "pending",
    createdAt: 0,
    updatedAt: 0,
   },
  ],
  nextId: id + 1,
 };
}

async function withTempStore(
 fn: (store: DurableTodoStore, rootDir: string) => Promise<void>,
): Promise<void> {
 const rootDir = await mkdtemp(join(tmpdir(), "pi-todo-p3b-"));
 try {
  const store = createFileDurableTodoStore({ rootDir });
  await fn(store, rootDir);
 } finally {
  await rm(rootDir, { recursive: true, force: true });
 }
}

// ── A. Load ─────────────────────────────────────────────────────────────

describe("FileDurableTodoStore: load", () => {
 it("★ 1 missing canonical → empty envelope (rev 0, EMPTY_STATE)", async () => {
  await withTempStore(async (store) => {
   const env = await store.load(SCOPE_A);
   assert.equal(env.revision, 0);
   assert.equal(env.schemaVersion, CURRENT_SCHEMA_VERSION);
   assert.deepEqual(env.state, emptyState());
  });
 });

 it("★ 2 missing load writes 0 (no .tmp or canonical files created)", async () => {
  await withTempStore(async (store, rootDir) => {
   await store.load(SCOPE_A);
   const entries = await readdir(rootDir);
   assert.deepEqual(entries, []);
  });
 });

 it("★ 3 canonical round-trip: write via encodeEnvelopeToString, read via load", async () => {
  // This test verifies the codec + file backend integration pipeline.
  // We exercise load after a real commit and verify load reads what
  // the store itself wrote (codec encode → atomic publish → codec
  // decode + migration on next load).
  await withTempStore(async (store) => {
   const r = await store.commit(SCOPE_A, 0, {
    tasks: [
     {
      id: 7,
      subject: "seed",
      status: "pending",
      createdAt: 100,
      updatedAt: 100,
     },
    ],
    nextId: 8,
   });
   assert.equal(r.kind, "committed");
   const env = await store.load(SCOPE_A);
   assert.equal(env.revision, 1);
   assert.equal(env.state.tasks[0]?.id, 7);
   assert.equal(env.state.tasks[0]?.subject, "seed");
  });
 });

 it("★ 4 malformed JSON in canonical → load throws PersistenceError(corrupt)", async () => {
  await withTempStore(async (store, rootDir) => {
   // Write a malformed file at the canonical path.
   // We don't know the hashed filename; instead, write one malformed
   // file with the .json suffix matching the hashed scheme. To keep
   // this test deterministic, write a file then make it discoverable.
   // Simpler approach: write directly to canonical via store.commit,
   // then overwrite with malformed bytes via raw fs.
   const r = await store.commit(SCOPE_A, 0, stateWith(1));
   assert.equal(r.kind, "committed");
   // Find the canonical file the store created (readdir is statically imported).
   const files = await readdir(rootDir);
   const jsonFile = files.find((f) => f.endsWith(".json"));
   assert.ok(jsonFile, "store should have created a .json canonical file");
   await writeFile(join(rootDir, jsonFile!), "not valid json{", "utf8");
   // Reload — must throw corrupt.
   let caught: unknown;
   try {
    await store.load(SCOPE_A);
   } catch (e) {
    caught = e;
   }
   assert.ok(caught, "expected load to throw");
   assert.equal((caught as { kind?: unknown }).kind, "corrupt");
  });
 });
});

// ── B. Commit ────────────────────────────────────────────────────────────

describe("FileDurableTodoStore: commit", () => {
 it("★ 5 missing + expected=0 → committed revision 1", async () => {
  await withTempStore(async (store) => {
   const r = await store.commit(SCOPE_A, 0, stateWith(1));
   assert.equal(r.kind, "committed");
   if (r.kind === "committed") {
    assert.equal(r.envelope.revision, 1);
    assert.equal(r.envelope.schemaVersion, CURRENT_SCHEMA_VERSION);
   }
  });
 });

 it("★ 6 current R + expected=R → committed R+1", async () => {
  await withTempStore(async (store) => {
   await store.commit(SCOPE_A, 0, stateWith(1));
   const r = await store.commit(SCOPE_A, 1, stateWith(2));
   assert.equal(r.kind, "committed");
   if (r.kind === "committed") {
    assert.equal(r.envelope.revision, 2);
   }
  });
 });

 it("★ 7 wrong expected → conflict, canonical file unchanged", async () => {
  await withTempStore(async (store, rootDir) => {
   await store.commit(SCOPE_A, 0, stateWith(1));
   const r = await store.commit(SCOPE_A, 99, stateWith(2));
   assert.equal(r.kind, "conflict");
   if (r.kind === "conflict") {
    assert.equal(r.expectedRevision, 99);
    assert.equal(r.actualRevision, 1);
   }
   // Canonical content unchanged.
   const files = await readdir(rootDir);
   const jsonFile = files.find((f) => f.endsWith(".json"));
   const text = await readFile(join(rootDir, jsonFile!), "utf8");
   // Verify envelope still reports revision 1.
   assert.match(text, /"revision":1/);
  });
 });

 it("★ 8 success writes CURRENT schemaVersion to canonical", async () => {
  await withTempStore(async (store, rootDir) => {
   await store.commit(SCOPE_A, 0, stateWith(1));
   const files = await readdir(rootDir);
   const jsonFile = files.find((f) => f.endsWith(".json"));
   const text = await readFile(join(rootDir, jsonFile!), "utf8");
   assert.match(text, new RegExp(`"schemaVersion":${CURRENT_SCHEMA_VERSION}`));
  });
 });

 it("★ 9 atomic publish: no leftover .tmp files after success", async () => {
  await withTempStore(async (store, rootDir) => {
   await store.commit(SCOPE_A, 0, stateWith(1));
   const files = await readdir(rootDir);
   const tmpFiles = files.filter((f) => f.includes(".tmp"));
   assert.equal(tmpFiles.length, 0, "no .tmp files after atomic publish");
  });
 });
});

// ── C. Restart / atomicity / stale tmp ──────────────────────────────────

describe("FileDurableTodoStore: restart / atomicity", () => {
 it("★ 10 restart: new store from same rootDir sees persisted state", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "pi-todo-p3b-"));
  try {
   // First store: write.
   const store1 = createFileDurableTodoStore({ rootDir });
   await store1.commit(SCOPE_A, 0, stateWith(42, "persisted"));

   // Second store from same rootDir: read.
   const store2 = createFileDurableTodoStore({ rootDir });
   const env = await store2.load(SCOPE_A);
   assert.equal(env.revision, 1);
   assert.equal(env.state.tasks[0]?.id, 42);
   assert.equal(env.state.tasks[0]?.subject, "persisted");

   // Sequential commit still works.
   const r = await store2.commit(SCOPE_A, 1, stateWith(43));
   assert.equal(r.kind, "committed");
   if (r.kind === "committed") {
    assert.equal(r.envelope.revision, 2);
   }
  } finally {
   await rm(rootDir, { recursive: true, force: true });
  }
 });

 it("★ 11 stale .tmp files in rootDir are ignored by load", async () => {
  await withTempStore(async (store, rootDir) => {
   // First commit to create canonical.
   await store.commit(SCOPE_A, 0, stateWith(1));
   // Plant a stale tmp file (simulating prior crashed write).
   const staleTmp = join(rootDir, ".stale-deadbeef.tmp");
   await writeFile(staleTmp, "garbage", "utf8");
   // Load must succeed (ignores .tmp).
   const env = await store.load(SCOPE_A);
   assert.equal(env.revision, 1);
   // The stale tmp may still exist (not auto-cleaned by v0).
  });
 });

 it("★ 12 different scopes have different canonical files (SHA-256 isolation)", async () => {
  await withTempStore(async (store, rootDir) => {
   await store.commit(SCOPE_A, 0, stateWith(1));
   await store.commit(SCOPE_B, 0, stateWith(2));
   const files = await readdir(rootDir);
   const jsonFiles = files.filter((f) => f.endsWith(".json"));
   assert.equal(jsonFiles.length, 2, "two scopes → two canonical files");
   // Read both and verify each encodes the correct scope's content.
   let aContent: string | null = null;
   let bContent: string | null = null;
   for (const f of jsonFiles) {
    const text = await readFile(join(rootDir, f), "utf8");
    if (text.includes("task 1")) aContent = text;
    if (text.includes("task 2")) bContent = text;
   }
   assert.ok(aContent, "scope A canonical encodes task 1");
   assert.ok(bContent, "scope B canonical encodes task 2");
  });
 });
});

// ── D. Architecture ──────────────────────────────────────────────────────

describe("file-durable-store: architecture", () => {
 it("★ 13 no sid / sessionManager / runtime identity references", async () => {
  const src = await readFile("file-durable-store.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/sid\s*\(/.test(code), "must not call sid()");
  assert.ok(!/sessionManager/.test(code), "must not reference sessionManager");
 });

 it("★ 14 no P0/P1/P2 runtime imports", async () => {
  const src = await readFile("file-durable-store.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
   "./store",
   "./reducer",
   "./mutation-",
   "./index",
   "./graph",
   "./projection",
   "./read-model",
   "./format",
   "./overlay",
  ];
  for (const m of forbidden) {
   assert.ok(
    !code.includes(`from "${m}"`),
    `file-durable-store.ts must not import from "${m}"`,
   );
  }
 });

 it("★ 15 no UX / CLI / formatter vocabulary; no journal / replay", async () => {
  const src = await readFile("file-durable-store.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbiddenUX = [
   "Usage: /todos",
   "Conflict",
   "Task #",
   "Now ready",
   "Re-blocked",
   "Blocked by:",
  ];
  const forbiddenJournal = [
   "journal",
   "replay",
   "ReplayMutationMaterial",
   "CommittedMutationRecord",
  ];
  for (const s of [...forbiddenUX, ...forbiddenJournal]) {
   assert.ok(
    !code.includes(s),
    `file-durable-store.ts contains forbidden vocabulary "${s}"`,
   );
  }
 });
});
