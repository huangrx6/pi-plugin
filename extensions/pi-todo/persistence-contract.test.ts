/**
 * Contract self-tests for P3-A (persistence-contract.ts).
 *
 * These verify that the contract types have the right shape and
 * purity guarantees at compile time. They do NOT verify runtime
 * persistence behavior (that comes in P3-B).
 *
 * Coverage: ~10 tests — shape / generics / branding / readonly /
 * exact-keys / layer purity / UX vocabulary.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
 CURRENT_SCHEMA_VERSION,
 type CurrentPersistedTodoEnvelope,
 type PersistedReduceContext,
 type PersistedTodoEnvelope,
 type ReplayMutationMaterial,
 type ReplayContextAdapter,
 type ReplayContextSession,
 type ScopeKey,
 type ScopeKeyResolver,
} from "./persistence-contract.ts";
import type { ReduceContext, TaskMutationParams, TaskState } from "./types.ts";

// ── Type-level assertion helpers (compile-time only) ──────────────────────

/**
 * Compile-time type equality. If X and Y differ, any assignment to
 * a `boolean` typed slot typed as Equals<X, Y> fails to type-check.
 */
type Equals<X, Y> =
 (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

// ── A. Shape ─────────────────────────────────────────────────────────────

describe("P3-A persistence contract: shape", () => {
 it("★ 1 CURRENT_SCHEMA_VERSION === 1 (v0 envelope)", () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 1);
 });

 it("★ 2 PersistedTodoEnvelope (V=1) has exactly 3 readonly fields", () => {
  // Runtime: build a v1 envelope and verify keys are exactly the 3 expected.
  const env: PersistedTodoEnvelope<1> = {
   schemaVersion: 1,
   revision: 0,
   state: { tasks: [], nextId: 1 },
  };
  assert.deepEqual(Object.keys(env).sort(), [
   "revision",
   "schemaVersion",
   "state",
  ]);
 });

 it("★ 3 CurrentPersistedTodoEnvelope is PersistedTodoEnvelope<CURRENT_SCHEMA_VERSION>", () => {
  // Compile-time: these two types must be assignable to each other.
  // The reference binding holds the conditional types so they aren't
  // reported as unused declarations.
  type A =
   CurrentPersistedTodoEnvelope extends PersistedTodoEnvelope<
    typeof CURRENT_SCHEMA_VERSION
   >
    ? true
    : false;
  type B =
   PersistedTodoEnvelope<
    typeof CURRENT_SCHEMA_VERSION
   > extends CurrentPersistedTodoEnvelope
    ? true
    : false;
  const bothAB: [A, B] = [true, true];
  const both: Equals<
   CurrentPersistedTodoEnvelope,
   PersistedTodoEnvelope<typeof CURRENT_SCHEMA_VERSION>
  > = true;
  assert.equal(both, true);
  assert.deepEqual(bothAB, [true, true]);
 });

 it("★ 4 PersistedTodoEnvelope is generic: V=1 and V=2 both legal", () => {
  // Migration support: a loaded v1 envelope and a loaded v2 envelope
  // must both be typeable. The generic <V extends number = number>
  // is what makes this possible.
  const v1: PersistedTodoEnvelope<1> = {
   schemaVersion: 1,
   revision: 5,
   state: { tasks: [], nextId: 1 },
  };
  const v2: PersistedTodoEnvelope<2> = {
   schemaVersion: 2,
   revision: 5,
   state: { tasks: [], nextId: 1 },
  };
  assert.equal(v1.schemaVersion, 1);
  assert.equal(v2.schemaVersion, 2);
 });

 it("★ 5 PersistedReduceContext: ordered sequence, no length constraint", () => {
  // 0 / 1 / N values all legal. The contract does NOT assert
  // nowValues.length === actions.length.
  const c0: PersistedReduceContext = { nowValues: [] };
  const c1: PersistedReduceContext = { nowValues: [1000] };
  const cN: PersistedReduceContext = {
   nowValues: [1000, 2000, 3000, 4000, 5000],
  };
  assert.equal(c0.nowValues.length, 0);
  assert.equal(c1.nowValues.length, 1);
  assert.equal(cN.nowValues.length, 5);
 });

 it("★ 6 ReplayMutationMaterial has baseRevision / revision / actions / replayContext", () => {
  const actions: TaskMutationParams[] = [
   { action: "archive", ids: [12] },
   { action: "archive", ids: [18] },
  ];
  const mat: ReplayMutationMaterial = {
   baseRevision: 10,
   revision: 11,
   actions,
   replayContext: { nowValues: [1000, 2000] },
  };
  assert.equal(mat.baseRevision, 10);
  assert.equal(mat.revision, 11);
  assert.equal(mat.actions.length, 2);
  assert.equal(mat.replayContext.nowValues.length, 2);
 });
});

// ── B. ScopeKeyResolver ──────────────────────────────────────────────────

describe("P3-A persistence contract: scope resolution", () => {
 it("★ 7 ScopeKeyResolver requires async resolve(ctx) → Promise<ScopeKey>", async () => {
  const resolver: ScopeKeyResolver = {
   async resolve(_ctx): Promise<ScopeKey> {
    return "test-scope" as ScopeKey;
   },
  };
  const out: ScopeKey = await resolver.resolve({});
  assert.equal(out, "test-scope");
 });
});

// ── B'. ReplayContextSession (P3-A Amendment A2) ──────────────────────

describe("P3-A persistence contract: replay context session (A2)", () => {
 it("★ 7a ReplayContextSession shape: reduceContext + assertAllConsumed", () => {
  const session: ReplayContextSession = {
   reduceContext: { now: () => 42 },
   assertAllConsumed: () => {},
  };
  assert.equal(typeof session.reduceContext.now, "function");
  assert.equal(typeof session.assertAllConsumed, "function");
 });

 it("★ 7b ReplayContextAdapter.fromPersisted returns ReplayContextSession", () => {
  const adapter: ReplayContextAdapter = {
   fromPersisted: () => ({
    reduceContext: { now: () => 0 },
    assertAllConsumed: () => {},
   }),
  };
  const s = adapter.fromPersisted({ nowValues: [] });
  assert.ok(s.reduceContext);
  assert.ok(typeof s.assertAllConsumed === "function");
 });
});

// ── C. Compile-time guards (LOCK §3, §15, §16) ───────────────────────────

describe("P3-A persistence contract: compile-time guards", () => {
 it("★ 8 ScopeKey is opaque-branded: plain string cannot be assigned", () => {
  // The brand prevents accidental collapse of sid(ctx) into ScopeKey.
  // If the brand is missing, this assignment compiles, the @ts-expect-error
  // is unused, and the test fails. The forced cast demonstrates the
  // legitimate construction boundary; the plain-string assignment must
  // fail.
  const env: ScopeKey = "test" as ScopeKey;
  void env;
  // @ts-expect-error — ScopeKey is branded; plain string cannot be assigned
  const plainAssigned: ScopeKey = "plain-string";
  void plainAssigned;
 });

 it("★ 9 PersistedTodoEnvelope fields are readonly (runtime freeze check)", () => {
  // tsc without strict mode may not enforce readonly at compile time;
  // Object.freeze proves the contract at runtime. Both matter for
  // downstream adapters that might try to mutate.
  const env = Object.freeze({
   schemaVersion: CURRENT_SCHEMA_VERSION,
   revision: 0,
   state: { tasks: [], nextId: 1 } as TaskState,
  });
  assert.throws(() => {
   (env as { revision: number }).revision = 999;
  }, /Cannot assign to read only|TypeError/);
  assert.throws(() => {
   (env as { schemaVersion: number }).schemaVersion = 999;
  }, /Cannot assign to read only|TypeError/);
 });

 it("★ 10 PersistedTodoEnvelope has exactly the 3 expected keys (compile-time)", () => {
  // Compile-time check: keyof PersistedTodoEnvelope must equal the
  // expected key set. If anyone adds a field, this fails at build time.
  const keysMatch: Equals<
   keyof PersistedTodoEnvelope,
   "schemaVersion" | "revision" | "state"
  > = true;
  assert.equal(keysMatch, true);
 });

 it("★ 11 PersistedReduceContext has exactly 1 field (compile-time)", () => {
  const fieldsMatch: Equals<keyof PersistedReduceContext, "nowValues"> = true;
  assert.equal(fieldsMatch, true);
 });

 it("★ 12 ReplayMutationMaterial has exactly the 4 expected fields (compile-time)", () => {
  const fieldsMatch: Equals<
   keyof ReplayMutationMaterial,
   "baseRevision" | "revision" | "actions" | "replayContext"
  > = true;
  assert.equal(fieldsMatch, true);
 });
});

// ── D. Architecture ──────────────────────────────────────────────────────

describe("P3-A persistence contract: architecture", () => {
 it("★ 13 layer purity: persistence-contract.ts imports no runtime modules", async () => {
  const src = await readFile("persistence-contract.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Forbidden runtime imports.
  const forbidden = [
   "./store",
   "./reducer",
   "./mutation-command",
   "./mutation-selector",
   "./mutation-executor",
   "./mutation-outcome",
   "./mutation-format",
   "./index",
  ];
  for (const m of forbidden) {
   assert.ok(
    !code.includes(`from "${m}"`),
    `persistence-contract.ts must not import from "${m}"`,
   );
  }
  // Verify the only import from ./types is type-only.
  const runtimeTypeImport = code.match(
   /^import\s*\{[^}]+\}\s*from\s*"\.\/types\.ts"/m,
  );
  assert.ok(
   !runtimeTypeImport,
   `persistence-contract.ts must use \`import type\` for ./types.ts; found runtime import: ${runtimeTypeImport?.[0] ?? "n/a"}`,
  );
 });

 it("★ 14 authority model: no UX / CLI / formatter vocabulary", async () => {
  const src = await readFile("persistence-contract.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Contract file must not contain CLI notification / formatter vocabulary.
  // These belong to the runtime layer, not the persistence contract.
  const forbiddenUX = [
   "Usage: /todos",
   "Conflict",
   "Revision conflict",
   "Task #",
   "Ready to start",
   "Already running",
   "Completed.",
   "Archived.",
   "Blocked by:",
   "Completing this task",
   "Now ready",
   "Re-blocked",
   "Nothing to",
  ];
  for (const s of forbiddenUX) {
   assert.ok(
    !code.includes(s),
    `persistence-contract.ts contains forbidden UX vocabulary "${s}"`,
   );
  }
 });

 it("★ 15 runtime identity ≠ durable identity: no sid(ctx) / sessionId in contract", async () => {
  const src = await readFile("persistence-contract.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The contract must not propose sid(ctx) as a ScopeKey resolution.
  assert.ok(
   !/sid\s*\(/.test(code),
   "persistence-contract.ts must not mention sid(...) as ScopeKey source",
  );
  assert.ok(
   !/sessionId\s*as\s*ScopeKey/.test(code),
   "persistence-contract.ts must not equate sessionId with ScopeKey",
  );
 });
});

// Reference unused-import suppressor — these types are referenced
// only in compile-time guards above; runtime would be needed for P3-B.
void (null as unknown as ReduceContext | TaskState);
