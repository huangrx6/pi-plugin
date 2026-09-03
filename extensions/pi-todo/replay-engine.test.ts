/**
 * Unit tests for replay-context.ts + replay-engine.ts (P3-D).
 *
 * Coverage: 25 tests across 7 groups.
 *   A. Single action replay (5)
 *   B. Multi-action replay (3)
 *   C. Context integrity (2)
 *   D. Material integrity (3)
 *   E. Chain recovery (5)
 *   F. Authority / reconstruction (5)
 *   G. Architecture / purity (2)
 *
 * Architecture tests use the `importsModule` + `stripComments` helpers
 * to recognize the project's actual `.ts` module specifiers and strip
 * block / line comments before static analysis.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import type { TaskState, TaskMutationParams } from "./types.ts";
import { normalizeTask } from "./types.ts";
import type { ReplayMutationMaterial } from "./persistence-contract.ts";
import {
 ReplayIntegrityError,
 replayMutationChain,
 replayMutationMaterial,
 type RecoveryCandidate,
 type ReplayResult,
 type ReplayState,
} from "./replay-engine.ts";

// ── Helpers ────────────────────────────────────────────────────────────

/** Recognize `./foo` and `./foo.ts` in import specifiers. */
function importsModule(code: string, module: string): boolean {
 const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
 return new RegExp(`from\\s+["']${escaped}(?:\\.ts)?["']`).test(code);
}

/** Strip block and line comments for static analysis. */
function stripComments(src: string): string {
 return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function emptyState(): TaskState {
 return { tasks: [], nextId: 1 };
}

function mkTask(
 id: number,
 status: "pending" | "in_progress" = "pending",
): ReturnType<typeof normalizeTask> {
 return normalizeTask({
  id,
  subject: `t${id}`,
  status,
  createdAt: 0,
  updatedAt: 0,
 });
}

function baseAt(
 revision: number,
 state: TaskState = emptyState(),
): ReplayState {
 return { revision, state };
}

function material(
 baseRevision: number,
 actions: TaskMutationParams[],
 nowValues: readonly number[] = [],
): ReplayMutationMaterial {
 return {
  baseRevision,
  revision: baseRevision + 1,
  actions,
  replayContext: { nowValues },
 };
}

// ── A. Single action replay (5) ──────────────────────────────────────

describe("replay-engine: single action", () => {
 it("★ 1 single 'start #1' action replays to in_progress @ R+1", () => {
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  const mat = material(0, [{ action: "start", id: 1 }], [100]);
  const result = replayMutationMaterial(base, mat);
  assert.equal(result.revision, 1);
  assert.equal(result.state.tasks[0]?.status, "in_progress");
 });

 it("★ 2 exact timestamps restored via replay context (nowValues consumed)", () => {
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  const mat = material(0, [{ action: "start", id: 1 }], [12345]);
  const result = replayMutationMaterial(base, mat);
  assert.equal(result.state.tasks[0]?.updatedAt, 12345);
 });

 it("★ 3 same input replay twice produces byte-equal output (deterministic)", () => {
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  const mat = material(0, [{ action: "start", id: 1 }], [777]);
  const a: ReplayResult = replayMutationMaterial(base, mat);
  const b: ReplayResult = replayMutationMaterial(base, mat);
  assert.deepEqual(a, b);
 });

 it("★ 4 replay does not mutate base.state (snapshot isolation)", () => {
  const baseState: TaskState = { tasks: [mkTask(1)], nextId: 2 };
  const before = JSON.parse(JSON.stringify(baseState));
  const base = baseAt(0, baseState);
  replayMutationMaterial(
   base,
   material(0, [{ action: "start", id: 1 }], [100]),
  );
  assert.deepEqual(baseState, before);
 });

 it("★ 5 replay does not mutate material (immutability)", () => {
  const mat = material(0, [{ action: "start", id: 1 }], [100]);
  const before = JSON.parse(JSON.stringify(mat));
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  replayMutationMaterial(base, mat);
  assert.deepEqual(mat, before);
 });
});

// ── B. Multi-action replay (3) ──────────────────────────────────────

describe("replay-engine: multi-action", () => {
 it("★ 6 multiple actions preserve order (sequential application)", () => {
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  const mat = material(
   0,
   [
    { action: "start", id: 1 },
    { action: "start", id: 2 },
   ],
   [100, 200],
  );
  const result = replayMutationMaterial(base, mat);
  assert.equal(result.state.tasks[0]?.status, "in_progress");
  assert.equal(result.state.tasks[1]?.status, "in_progress");
  assert.equal(result.state.tasks[0]?.updatedAt, 100);
  assert.equal(result.state.tasks[1]?.updatedAt, 200);
 });

 it("★ 7 failed 2nd action → ReplayIntegrityError, no partial state visible", () => {
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  // First action: start #1 (valid). Second: finish #2 (illegal — not in_progress).
  const mat = material(
   0,
   [
    { action: "start", id: 1 },
    { action: "finish", id: 2 },
   ],
   [100, 200],
  );
  assert.throws(
   () => replayMutationMaterial(base, mat),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });

 it("★ 8 nowValues consumed in order across actions (linear cursor)", () => {
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  // 3 actions; #1's start consumes 100, #2's start consumes 200, #1's finish consumes 300.
  const mat = material(
   0,
   [
    { action: "start", id: 1 },
    { action: "start", id: 2 },
    { action: "finish", id: 1 },
   ],
   [100, 200, 300],
  );
  const result = replayMutationMaterial(base, mat);
  assert.equal(result.state.tasks[0]?.status, "completed");
  assert.equal(result.state.tasks[0]?.updatedAt, 300);
  assert.equal(result.state.tasks[1]?.status, "in_progress");
  assert.equal(result.state.tasks[1]?.updatedAt, 200);
 });
});

// ── C. Context integrity (2) ──────────────────────────────────────

describe("replay-engine: context integrity", () => {
 it("★ 9 underflow (0 nowValues for 2 actions) → ReplayIntegrityError", () => {
  // 2 actions, 0 nowValues. First action calls now() → underflow thrown
  // by ctx → wrapped as ReplayIntegrityError.
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  const mat = material(
   0,
   [
    { action: "start", id: 1 },
    { action: "start", id: 2 },
   ],
   [],
  );
  assert.throws(
   () => replayMutationMaterial(base, mat),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });

 it("★ 10 overflow (1 action + 2 nowValues) → ReplayIntegrityError", () => {
  // 1 action consumes 1 value; 1 value remains → overflow thrown by
  // session.assertAllConsumed() → wrapped as ReplayIntegrityError.
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  const mat = material(0, [{ action: "start", id: 1 }], [100, 200]);
  assert.throws(
   () => replayMutationMaterial(base, mat),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });
});

// ── D. Material integrity (3) ──────────────────────────────────────

describe("replay-engine: material integrity", () => {
 it("★ 11 base revision mismatch → ReplayIntegrityError", () => {
  const base = baseAt(5);
  const mat = material(3, [{ action: "start", id: 1 }], [100]);
  assert.throws(
   () => replayMutationMaterial(base, mat),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });

 it("★ 12 material revision jump (not baseRevision + 1) → ReplayIntegrityError", () => {
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  const mat: ReplayMutationMaterial = {
   baseRevision: 0,
   revision: 99, // not baseRevision + 1
   actions: [{ action: "start", id: 1 }],
   replayContext: { nowValues: [100] },
  };
  assert.throws(
   () => replayMutationMaterial(base, mat),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });

 it("★ 13 reducer failure (illegal transition) → ReplayIntegrityError, NOT domain", () => {
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  // finish #1 is illegal (not in_progress); would be P1-C domain error
  // in a normal mutation. In replay it is ReplayIntegrityError.
  const mat = material(0, [{ action: "finish", id: 1 }], [100]);
  assert.throws(
   () => replayMutationMaterial(base, mat),
   (e: unknown) =>
    e instanceof ReplayIntegrityError &&
    e.kind === "replay-integrity" &&
    e.cause !== undefined,
  );
 });
});

// ── E. Chain recovery (5) ──────────────────────────────────────

describe("replay-engine: chain recovery", () => {
 it("★ 14 empty chain → returns base candidate (baseRevision == finalRevision)", () => {
  const base = baseAt(7, { tasks: [mkTask(99)], nextId: 100 });
  const c: RecoveryCandidate = replayMutationChain(base, []);
  assert.equal(c.baseRevision, 7);
  assert.equal(c.finalRevision, 7);
  assert.equal(c.state.tasks[0]?.id, 99);
 });

 it("★ 15 contiguous 3-record chain succeeds (R → R+1 → R+2 → R+3)", () => {
  const base = baseAt(0, {
   tasks: [mkTask(1), mkTask(2), mkTask(3)],
   nextId: 4,
  });
  const m0 = material(0, [{ action: "start", id: 1 }], [100]);
  const m1 = material(1, [{ action: "start", id: 2 }], [200]);
  const m2 = material(2, [{ action: "start", id: 3 }], [300]);
  const c = replayMutationChain(base, [m0, m1, m2]);
  assert.equal(c.baseRevision, 0);
  assert.equal(c.finalRevision, 3);
  assert.equal(c.state.tasks[0]?.status, "in_progress");
  assert.equal(c.state.tasks[1]?.status, "in_progress");
  assert.equal(c.state.tasks[2]?.status, "in_progress");
 });

 it("★ 16 chain with gap fails closed", () => {
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  const m0 = material(0, [{ action: "start", id: 1 }], [100]);
  // m1 has baseRevision=2 (skipping R=1).
  const m1 = material(2, [{ action: "start", id: 2 }], [200]);
  assert.throws(
   () => replayMutationChain(base, [m0, m1]),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });

 it("★ 17 chain with duplicate (same baseRevision) fails closed", () => {
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  const m0 = material(0, [{ action: "start", id: 1 }], [100]);
  // m1 has baseRevision=0 again (duplicate).
  const m1 = material(0, [{ action: "start", id: 2 }], [200]);
  assert.throws(
   () => replayMutationChain(base, [m0, m1]),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });

 it("★ 18 chain out-of-order fails closed", () => {
  const base = baseAt(0, { tasks: [mkTask(1), mkTask(2)], nextId: 3 });
  const m0 = material(0, [{ action: "start", id: 1 }], [100]);
  const m1 = material(1, [{ action: "start", id: 2 }], [200]);
  // Materials given in reverse order.
  assert.throws(
   () => replayMutationChain(base, [m1, m0]),
   (e: unknown) => e instanceof ReplayIntegrityError,
  );
 });
});

// ── F. Authority / reconstruction (5) ─────────────────────────────

describe("replay-engine: authority / reconstruction", () => {
 it("★ 19 successful chain does NOT call durable store (P3-D is pure)", async () => {
  const src = await readFile("replay-engine.ts", "utf8");
  const code = stripComments(src);
  assert.ok(
   !importsModule(code, "./file-durable-store"),
   "replay-engine must not import file-durable-store",
  );
  assert.ok(
   !importsModule(code, "./durable-store"),
   "replay-engine must not import durable-store",
  );
  assert.ok(
   !importsModule(code, "./store"),
   "replay-engine must not import runtime store",
  );
 });

 it("★ 20 no CLI parser / selector / formatter / mutation-wiring imports", async () => {
  const src = await readFile("replay-engine.ts", "utf8");
  const code = stripComments(src);
  const forbidden = [
   "./mutation-command",
   "./mutation-selector",
   "./mutation-format",
   "./mutation-wiring",
   "./mutation-outcome",
   "./index",
  ];
  for (const m of forbidden) {
   assert.ok(
    !importsModule(code, m),
    `replay-engine must not import from ${m}`,
   );
  }
 });

 it("★ 21 only runtime dep: reducer (sole domain semantic)", async () => {
  const src = await readFile("replay-engine.ts", "utf8");
  const code = stripComments(src);
  assert.ok(
   importsModule(code, "./reducer"),
   "replay-engine must import reducer for sole domain authority",
  );
  assert.ok(!importsModule(code, "./graph"));
  assert.ok(!importsModule(code, "./projection"));
  assert.ok(!importsModule(code, "./read-model"));
  assert.ok(!importsModule(code, "./format"));
 });

 it("★ 22 no journal implementation in P3-D v0", async () => {
  const src = await readFile("replay-engine.ts", "utf8");
  const code = stripComments(src);
  // P3-A defines ReplayMutationMaterial; P3-D adds ReplayIntegrityError.
  // A "journal" would add a separate committed-record type / sequence
  // counter. v0 has none of that.
  assert.ok(
   !code.includes("CommittedMutationRecord"),
   "no journal-specific record type in P3-D v0",
  );
  assert.ok(
   !/append|sequence|checkpoint|compaction|fsync/.test(code),
   "no journal machinery in P3-D v0",
  );
 });

 it("★ 23 P3-D replay output is reconstruction-only (not envelope-shaped)", () => {
  // The replay result has revision + state but no schemaVersion
  // (envelope shape is P3-B authority). This proves P3-D cannot
  // promote its output to durable state directly.
  const base = baseAt(0, { tasks: [mkTask(1)], nextId: 2 });
  const result = replayMutationMaterial(
   base,
   material(0, [{ action: "start", id: 1 }], [100]),
  );
  assert.ok("revision" in result);
  assert.ok("state" in result);
  assert.ok(
   !("schemaVersion" in result),
   "ReplayResult must NOT be envelope-shaped (P3-D is reconstruction-only)",
  );
 });
});

// ── G. Architecture / purity (2) ─────────────────────────────────

describe("replay-engine: architecture / purity", () => {
 it("★ 24 no ScopeKey / session identity / workspace-scope (LOCK §13)", async () => {
  const src = await readFile("replay-engine.ts", "utf8");
  const code = stripComments(src);
  assert.ok(!/ScopeKey/.test(code), "no ScopeKey");
  assert.ok(!/sessionManager/.test(code), "no sessionManager");
  assert.ok(!/workspace-scope/.test(code), "no workspace-scope");
 });

 it("★ 25 replay-context.ts purity (no P3-B durable store / commit)", async () => {
  const src = await readFile("replay-context.ts", "utf8");
  const code = stripComments(src);
  assert.ok(!importsModule(code, "./file-durable-store"));
  assert.ok(!importsModule(code, "./durable-store"));
  assert.ok(!/commitState/.test(code));
  assert.ok(!/writeFile/.test(code));
 });
});
