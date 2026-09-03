/**
 * Unit tests for mutation-selector.ts (P1-A).
 *
 * Scope (LOCKED P1 v0):
 *   - parseSelectorTokens: ids / named parsing
 *   - normalizeSelector: dedupe ids preserving first occurrence
 *   - resolveSelectorIds: against immutable snapshot
 *   - validateMutationCommand: policy matrix
 *
 * Critical invariants tested:
 *   1. Named selectors consume canonical projection queries
 *      (selectCompletedTaskIds / selectArchivedTaskIds / selectAllTaskIds);
 *      NOT raw state.tasks.filter(...)
 *   2. Explicit-id: nonexistent AND deleted tombstone BOTH → notFound
 *   3. Named: deleted silently excluded (B3 behavior)
 *   4. Policy: 4 rejected combos (archive archived, archive all,
 *      restore completed, restore all) → SELECTOR_NOT_ALLOWED
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
 normalizeSelector,
 parseAndNormalizeSelector,
 parseSelectorTokens,
 resolveSelectorIds,
 validateMutationCommand,
} from "./mutation-selector.ts";
import { EMPTY_STATE, normalizeTask } from "./types.ts";
import type { MutationCommand, Selector, TaskState } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function mkTask(
 overrides: Partial<TaskState["tasks"][number]> & { id: number },
): TaskState["tasks"][number] {
 return normalizeTask({
  subject: `task ${overrides.id}`,
  status: "pending",
  ...overrides,
 });
}

function mkState(...tasks: TaskState["tasks"][number][]): TaskState {
 return { tasks: [...tasks], nextId: 1000 };
}

// ── parseSelectorTokens ──────────────────────────────────────────────────

describe("parseSelectorTokens", () => {
 it("all integers → ids", () => {
  const s = parseSelectorTokens(["12", "18", "21"]);
  assert.ok(s !== null);
  assert.equal(s?.kind, "ids");
  if (s?.kind === "ids") assert.deepEqual(s.ids, [12, 18, 21]);
 });

 it("0012 accepted as 12", () => {
  const s = parseSelectorTokens(["0012"]);
  if (s?.kind === "ids") assert.deepEqual(s.ids, [12]);
 });

 it("single named keyword → named", () => {
  assert.deepEqual(parseSelectorTokens(["completed"]), {
   kind: "named",
   name: "completed",
  });
  assert.deepEqual(parseSelectorTokens(["archived"]), {
   kind: "named",
   name: "archived",
  });
  assert.deepEqual(parseSelectorTokens(["all"]), {
   kind: "named",
   name: "all",
  });
 });

 it("empty → null", () => {
  assert.equal(parseSelectorTokens([]), null);
 });

 it("non-positive integer → null", () => {
  assert.equal(parseSelectorTokens(["0"]), null);
  assert.equal(parseSelectorTokens(["12", "0", "18"]), null);
 });

 it("float → null", () => {
  assert.equal(parseSelectorTokens(["1.5"]), null);
 });

 it("non-numeric → null", () => {
  assert.equal(parseSelectorTokens(["abc"]), null);
  assert.equal(parseSelectorTokens(["completed", "12"]), null); // mixed
  assert.equal(parseSelectorTokens(["12", "archived"]), null); // mixed
 });

 it("multiple named keywords → null", () => {
  assert.equal(parseSelectorTokens(["completed", "archived"]), null);
 });

 it("unknown keyword → null", () => {
  assert.equal(parseSelectorTokens(["ready"]), null);
  assert.equal(parseSelectorTokens(["foo"]), null);
 });

 it("above safe integer → null", () => {
  assert.equal(
   parseSelectorTokens([String(Number.MAX_SAFE_INTEGER) + "9"]),
   null,
  );
 });
});

// ── normalizeSelector ────────────────────────────────────────────────────

describe("normalizeSelector", () => {
 it("dedupes ids preserving first occurrence order", () => {
  const sel: Selector = { kind: "ids", ids: [8, 3, 8, 12, 3] };
  const out = normalizeSelector(sel);
  assert.deepEqual(out, { kind: "ids", ids: [8, 3, 12] });
 });

 it("named → unchanged", () => {
  const sel: Selector = { kind: "named", name: "completed" };
  assert.deepEqual(normalizeSelector(sel), sel);
 });

 it("single id → unchanged", () => {
  assert.deepEqual(normalizeSelector({ kind: "ids", ids: [17] }), {
   kind: "ids",
   ids: [17],
  });
 });
});

// ── resolveSelectorIds ───────────────────────────────────────────────────

describe("resolveSelectorIds", () => {
 const completed = mkTask({ id: 17, status: "completed" });
 const archivedCompleted = mkTask({
  id: 18,
  status: "completed",
  archivedAt: 100,
 });
 const pendingArchived = mkTask({
  id: 19,
  status: "pending",
  archivedAt: 200,
 });
 const deleted = mkTask({ id: 99, status: "deleted" });

 it("named 'completed' → canonical selectCompletedTaskIds (excludes archived)", () => {
  const state = mkState(completed, archivedCompleted, pendingArchived);
  const r = resolveSelectorIds(state, { kind: "named", name: "completed" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ids, [17]);
 });

 it("named 'archived' → canonical selectArchivedTaskIds (excludes deleted)", () => {
  const state = mkState(archivedCompleted, pendingArchived, deleted);
  const r = resolveSelectorIds(state, { kind: "named", name: "archived" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ids.sort(), [18, 19]);
 });

 it("named 'all' → canonical selectAllTaskIds (excludes deleted)", () => {
  const state = mkState(completed, archivedCompleted, deleted);
  const r = resolveSelectorIds(state, { kind: "named", name: "all" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ids, [17, 18]);
 });

 it("ids: existing visible → ok ids", () => {
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const r = resolveSelectorIds(state, { kind: "ids", ids: [17] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ids, [17]);
 });

 it("ids: nonexistent → notFound", () => {
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const r = resolveSelectorIds(state, { kind: "ids", ids: [999] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.notFound, [999]);
 });

 it("ids: deleted tombstone → notFound (user can't distinguish from nonexistent)", () => {
  const state = mkState(mkTask({ id: 17, status: "deleted" }));
  const r = resolveSelectorIds(state, { kind: "ids", ids: [17] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.notFound, [17]);
 });

 it("ids: mixed nonexistent + deleted + existing → all in notFound, none in ids", () => {
  const state = mkState(
   mkTask({ id: 1, status: "pending" }),
   mkTask({ id: 2, status: "deleted" }),
  );
  const r = resolveSelectorIds(state, { kind: "ids", ids: [1, 2, 999] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.notFound.sort(), [2, 999]);
 });

 it("ids: duplicate input → dedup, single result entry", () => {
  const state = mkState(mkTask({ id: 17, status: "pending" }));
  const r = resolveSelectorIds(state, { kind: "ids", ids: [17, 17, 17] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ids, [17]);
 });

 it("empty ids selector → ok with empty ids", () => {
  const r = resolveSelectorIds(EMPTY_STATE, { kind: "ids", ids: [] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ids, []);
 });
});

// ── validateMutationCommand ──────────────────────────────────────────────

describe("validateMutationCommand: policy matrix", () => {
 it("archive { ids } → ok", () => {
  expectPolicy("ok", {
   kind: "archive",
   selector: { kind: "ids", ids: [12] },
  } as MutationCommand);
 });

 it("archive { named completed } → ok", () => {
  expectPolicy("ok", {
   kind: "archive",
   selector: { kind: "named", name: "completed" },
  } as MutationCommand);
 });

 it("archive { named archived } → SELECTOR_NOT_ALLOWED (1 of 4)", () => {
  const r = validateMutationCommand({
   kind: "archive",
   selector: { kind: "named", name: "archived" },
  } as MutationCommand);
  assert.equal(r.ok, false);
  if (!r.ok) {
   assert.equal(r.error.code, "SELECTOR_NOT_ALLOWED");
   assert.equal(r.error.command, "archive");
   assert.equal(r.error.selector, "archived");
  }
 });

 it("archive { named all } → SELECTOR_NOT_ALLOWED (2 of 4)", () => {
  const r = validateMutationCommand({
   kind: "archive",
   selector: { kind: "named", name: "all" },
  } as MutationCommand);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.selector, "all");
 });

 it("restore { ids } → ok", () => {
  expectPolicy("ok", {
   kind: "restore",
   selector: { kind: "ids", ids: [12] },
  } as MutationCommand);
 });

 it("restore { named archived } → ok", () => {
  expectPolicy("ok", {
   kind: "restore",
   selector: { kind: "named", name: "archived" },
  } as MutationCommand);
 });

 it("restore { named completed } → SELECTOR_NOT_ALLOWED (3 of 4)", () => {
  const r = validateMutationCommand({
   kind: "restore",
   selector: { kind: "named", name: "completed" },
  } as MutationCommand);
  assert.equal(r.ok, false);
  if (!r.ok) {
   assert.equal(r.error.selector, "completed");
   assert.equal(r.error.command, "restore");
  }
 });

 it("restore { named all } → SELECTOR_NOT_ALLOWED (4 of 4)", () => {
  const r = validateMutationCommand({
   kind: "restore",
   selector: { kind: "named", name: "all" },
  } as MutationCommand);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.selector, "all");
 });

 it("lifecycle commands (start/finish/reopen) always ok regardless of id", () => {
  expectPolicy("ok", { kind: "start", id: 17 } as MutationCommand);
  expectPolicy("ok", { kind: "finish", id: 17 } as MutationCommand);
  expectPolicy("ok", { kind: "reopen", id: 17 } as MutationCommand);
 });

 it("★ policy counts: exactly 4 rejected (P1 v0 invariant)", () => {
  // Exhaustively check every (command, named) combination.
  const nameds = ["completed", "archived", "all"] as const;
  const archives: MutationCommand[] = nameds.map((n) => ({
   kind: "archive",
   selector: { kind: "named", name: n },
  }));
  const restores: MutationCommand[] = nameds.map((n) => ({
   kind: "restore",
   selector: { kind: "named", name: n },
  }));
  const allCmds = [...archives, ...restores];
  let rejectedCount = 0;
  for (const cmd of allCmds) {
   const r = validateMutationCommand(cmd);
   if (!r.ok) rejectedCount++;
  }
  assert.equal(rejectedCount, 4);
 });

 function expectPolicy(expected: "ok" | "reject", cmd: MutationCommand) {
  const r = validateMutationCommand(cmd);
  if (expected === "ok") {
   assert.equal(r.ok, true, `expected ok for ${JSON.stringify(cmd)}`);
  } else {
   assert.equal(r.ok, false);
  }
 }
});

// ── parseAndNormalizeSelector ────────────────────────────────────────────

describe("parseAndNormalizeSelector", () => {
 it("ids with duplicates → deduped", () => {
  const r = parseAndNormalizeSelector(["5", "5", "3", "5"]);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.selector, { kind: "ids", ids: [5, 3] });
 });

 it("named → unchanged", () => {
  const r = parseAndNormalizeSelector(["completed"]);
  assert.deepEqual(r, {
   ok: true,
   selector: { kind: "named", name: "completed" },
  });
 });

 it("syntax error → { ok: false, error: SYNTAX }", () => {
  assert.deepEqual(parseAndNormalizeSelector([]), {
   ok: false,
   error: "SYNTAX",
  });
  assert.deepEqual(parseAndNormalizeSelector(["abc"]), {
   ok: false,
   error: "SYNTAX",
  });
 });
});

// ── Layer purity ────────────────────────────────────────────────────────

describe("mutation-selector: layer purity", () => {
 it("does not import graph / reducer / format / mutation-command", async () => {
  const src = await readFile("mutation-selector.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = ["./graph", "./reducer", "./format", "./mutation-command"];
  for (const path of forbidden) {
   assert.ok(
    !code.includes(path),
    `mutation-selector.ts contains forbidden import "${path}"`,
   );
  }
 });
});
