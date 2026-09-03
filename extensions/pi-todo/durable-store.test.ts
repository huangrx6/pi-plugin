/**
 * Tests for durable-store.ts (P3-B.3 reference implementation).
 *
 * Covers the InMemoryDurableTodoStore:
 *   A. Load semantics (5 tests)
 *   B. Commit semantics (5 tests)
 *   C. Concurrency / CAS (2 tests)
 *   D. Snapshot isolation (2 tests — P3-B §24 LOCK)
 *   E. Architecture (3 tests — layer purity)
 *
 * The reference implementation exists to prove CAS semantics without
 * filesystem coupling. The real durable backend (file-durable-store)
 * is tested in file-durable-store.test.ts and exercises the codec +
 * migration integration pipeline.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
 CURRENT_SCHEMA_VERSION,
 type ScopeKey,
} from "./persistence-contract.ts";
import type { TaskState } from "./types.ts";
import {
 createInMemoryDurableTodoStore,
 type DurableTodoStore,
} from "./durable-store.ts";

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

// ── A. Load semantics ───────────────────────────────────────────────────

describe("InMemoryDurableTodoStore: load", () => {
 it("★ 1 missing scope → empty envelope (revision 0, EMPTY_STATE)", async () => {
  const store = createInMemoryDurableTodoStore();
  const env = await store.load(SCOPE_A);
  assert.equal(env.revision, 0);
  assert.equal(env.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(env.state, emptyState());
 });

 it("★ 2 missing load writes 0 (no side effect)", async () => {
  const store = createInMemoryDurableTodoStore();
  await store.load(SCOPE_A);
  await store.load(SCOPE_B);
  // Subsequent commit still starts from revision 0 (no read-induced mutation).
  const result = await store.commit(SCOPE_A, 0, stateWith(1));
  assert.equal(result.kind, "committed");
  if (result.kind === "committed") {
   assert.equal(result.envelope.revision, 1);
  }
 });

 it("★ 3 after commit, load returns committed envelope", async () => {
  const store = createInMemoryDurableTodoStore();
  const s = stateWith(7, "alpha");
  await store.commit(SCOPE_A, 0, s);
  const env = await store.load(SCOPE_A);
  assert.equal(env.revision, 1);
  assert.equal(env.state.tasks[0]?.id, 7);
  assert.equal(env.state.tasks[0]?.subject, "alpha");
 });

 it("★ 4 load returns detached state snapshot (mutation isolated)", async () => {
  const store = createInMemoryDurableTodoStore();
  await store.commit(SCOPE_A, 0, stateWith(1));
  const env1 = await store.load(SCOPE_A);
  // Mutate the returned envelope.
  env1.state.tasks.push({
   id: 999,
   subject: "injected",
   status: "pending",
   createdAt: 0,
   updatedAt: 0,
  });
  env1.state.nextId = 1000;
  // Reload — must NOT see the injected mutation.
  const env2 = await store.load(SCOPE_A);
  assert.equal(env2.state.tasks.length, 1);
  assert.equal(env2.state.tasks[0]?.id, 1);
  assert.equal(env2.state.nextId, 2);
 });

 it("★ 5 commit captures detached snapshot of nextState (mutation isolated)", async () => {
  const store = createInMemoryDurableTodoStore();
  const s = stateWith(1);
  const result = await store.commit(SCOPE_A, 0, s);
  assert.equal(result.kind, "committed");
  // Mutate caller's original nextState AFTER commit.
  s.tasks.push({
   id: 999,
   subject: "injected",
   status: "pending",
   createdAt: 0,
   updatedAt: 0,
  });
  // Reload — must NOT see the mutation.
  const env = await store.load(SCOPE_A);
  assert.equal(env.state.tasks.length, 1);
  assert.equal(env.state.tasks[0]?.id, 1);
 });
});

// ── B. Commit semantics ─────────────────────────────────────────────────

describe("InMemoryDurableTodoStore: commit", () => {
 it("★ 6 missing + expected=0 → committed revision 1", async () => {
  const store = createInMemoryDurableTodoStore();
  const result = await store.commit(SCOPE_A, 0, stateWith(1));
  assert.equal(result.kind, "committed");
  if (result.kind === "committed") {
   assert.equal(result.envelope.revision, 1);
   assert.equal(result.envelope.schemaVersion, CURRENT_SCHEMA_VERSION);
  }
 });

 it("★ 7 current R + expected=R → committed R+1", async () => {
  const store = createInMemoryDurableTodoStore();
  await store.commit(SCOPE_A, 0, stateWith(1));
  const r = await store.commit(SCOPE_A, 1, stateWith(2));
  assert.equal(r.kind, "committed");
  if (r.kind === "committed") {
   assert.equal(r.envelope.revision, 2);
   assert.equal(r.envelope.state.tasks[0]?.id, 2);
  }
 });

 it("★ 8 wrong expected → conflict, no write", async () => {
  const store = createInMemoryDurableTodoStore();
  await store.commit(SCOPE_A, 0, stateWith(1));
  const r = await store.commit(SCOPE_A, 99, stateWith(2));
  assert.equal(r.kind, "conflict");
  if (r.kind === "conflict") {
   assert.equal(r.expectedRevision, 99);
   assert.equal(r.actualRevision, 1);
  }
  // State unchanged.
  const env = await store.load(SCOPE_A);
  assert.equal(env.state.tasks[0]?.id, 1);
  assert.equal(env.revision, 1);
 });

 it("★ 9 sequential 0 → 1 → 2 → 3", async () => {
  const store = createInMemoryDurableTodoStore();
  for (let i = 0; i < 3; i++) {
   const r = await store.commit(SCOPE_A, i, stateWith(i + 1));
   assert.equal(r.kind, "committed");
  }
  const env = await store.load(SCOPE_A);
  assert.equal(env.revision, 3);
 });

 it("★ 10 equal-state commit still advances revision (no suppression)", async () => {
  const store = createInMemoryDurableTodoStore();
  const s = stateWith(1);
  const r1 = await store.commit(SCOPE_A, 0, s);
  assert.equal(r1.kind, "committed");
  // Same state, same expected — still must advance revision (P3-B §14).
  const r2 = await store.commit(SCOPE_A, 1, s);
  assert.equal(r2.kind, "committed");
  if (r2.kind === "committed") {
   assert.equal(r2.envelope.revision, 2);
  }
 });
});

// ── C. Concurrency / CAS ────────────────────────────────────────────────

describe("InMemoryDurableTodoStore: concurrency", () => {
 it("★ 11 two writers same expected → exactly 1 commit + 1 conflict", async () => {
  const store = createInMemoryDurableTodoStore();
  const results = await Promise.all([
   store.commit(SCOPE_A, 0, stateWith(1)),
   store.commit(SCOPE_A, 0, stateWith(2)),
  ]);
  const winners = results.filter((r) => r.kind === "committed");
  const losers = results.filter((r) => r.kind === "conflict");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  if (losers[0]?.kind === "conflict") {
   assert.equal(losers[0].expectedRevision, 0);
   assert.equal(losers[0].actualRevision, 1);
  }
 });

 it("★ 12 different scopes don't block each other", async () => {
  const store = createInMemoryDurableTodoStore();
  // Interleave commits on two scopes; both must succeed.
  const [a, b] = await Promise.all([
   store.commit(SCOPE_A, 0, stateWith(1)),
   store.commit(SCOPE_B, 0, stateWith(2)),
  ]);
  assert.equal(a.kind, "committed");
  assert.equal(b.kind, "committed");
 });
});

// ── D. Snapshot isolation (LOCK §24) — covered above by #4, #5 ────────────

// ── E. Architecture ──────────────────────────────────────────────────────

describe("durable-store: architecture", () => {
 it("★ 13 no sid / sessionManager / runtime identity references", async () => {
  const src = await readFile("durable-store.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/sid\s*\(/.test(code), "must not call sid()");
  assert.ok(!/sessionManager/.test(code), "must not reference sessionManager");
  assert.ok(
   !/sessionId\s+as\s+ScopeKey/.test(code),
   "must not equate sessionId with ScopeKey",
  );
 });

 it("★ 14 no P0/P1/P2 runtime imports", async () => {
  const src = await readFile("durable-store.ts", "utf8");
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
    `durable-store.ts must not import from "${m}"`,
   );
  }
 });

 it("★ 15 no UX / CLI / formatter vocabulary; no journal / replay", async () => {
  const src = await readFile("durable-store.ts", "utf8");
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
    `durable-store.ts contains forbidden vocabulary "${s}"`,
   );
  }
 });
});
