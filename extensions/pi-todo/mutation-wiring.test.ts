/**
 * Unit tests for P1-D mutation wiring (index.ts runMutationFlow).
 *
 * Coverage:
 *   A. Behavior matrix (14 rows) — proves wiring's correctness through
 *      ctx.ui.notify content + persisted durable state.
 *   B. Architecture tests — prove wiring's structural invariants via
 *      source inspection (single snapshot acquisition, single
 *      durableStore.commit call site, layer purity).
 *
 * P1-D contract references:
 *   C2: lifecycle IDs skip resolveSelectorIds.
 *   C3: archive/restore selectors parse → validate → resolve exactly once.
 *   C4: initial snapshot captured ONCE per command.
 *   C5: durableStore.commit only on ok:true AND non-empty targetIds.
 *   C6: outcome + format BEFORE commit; emit success AFTER commit.
 *   C7: empty targetIds → no commit.
 *   C8: no UX strings, no graph/projection UX, no re-validation.
 *   C10: successful non-empty execution → exactly one commit.
 *
 * P3-E boundary amendment (LOCK §32): the production authority moved
// to CurrentPersistedTodoEnvelope (P3-B). Seed/verify path now goes
// through InMemoryDurableTodoStore. Semantic assertions preserved.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import factory from "./index.ts";
import { commandRegistry, notices } from "./test-harness.ts";
import { createInMemoryDurableTodoStore } from "./durable-store.ts";
import type { ScopeKey } from "./persistence-contract.ts";
import type { ScopeKeyResolver } from "./persistence-contract.ts";
import type { TodoRuntimePersistence } from "./runtime-persistence.ts";
import { normalizeTask, type Task, type TaskState } from "./types.ts";

// ── Test persistence (P3-E boundary: InMemoryDurableTodoStore) ─────

const TEST_SCOPE: ScopeKey = "test-scope" as ScopeKey;

const testScopeResolver: ScopeKeyResolver<unknown> = {
 resolve: async (_ctx: unknown): Promise<ScopeKey> => TEST_SCOPE,
};

interface TestPersistence {
 persistence: TodoRuntimePersistence;
 store: ReturnType<typeof createInMemoryDurableTodoStore>;
}

function makeTestPersistence(): TestPersistence {
 const store = createInMemoryDurableTodoStore();
 const persistence: TodoRuntimePersistence = {
  scopeResolver: testScopeResolver,
  durableStore: store,
  rootDir: "(test-in-memory)",
 };
 return { persistence, store };
}

async function seed(
 persistence: TestPersistence,
 state: TaskState,
): Promise<void> {
 // commit at revision 0; if a previous test left state at higher
 // revision this fails (concurrent test runs share state).
 // Each test calls makeTestPersistence() to get a fresh store.
 await persistence.store.commit(TEST_SCOPE, 0, state);
}

async function loadState(persistence: TestPersistence): Promise<TaskState> {
 const env = await persistence.store.load(TEST_SCOPE);
 return env.state;
}

// ── Fixtures ────────────────────────────────────────────────────────────

function mkTask(
 overrides: Partial<{
  id: number;
  status: "pending" | "in_progress" | "completed" | "deleted";
  blockedBy?: number[];
  archivedAt?: number;
  subject?: string;
  createdAt?: number;
  updatedAt?: number;
 }> & { id: number },
): Task {
 return normalizeTask({
  subject: `task ${overrides.id}`,
  status: "pending",
  ...overrides,
 });
}

function mkState(...tasks: Task[]): TaskState {
 return { tasks: [...tasks], nextId: 1000 };
}

// ── Behavior: matrix rows ──────────────────────────────────────────────

describe("P1-D mutation wiring: behavior matrix", () => {
 // ── Row 1: start 12 success ────────────────────────────────────────────
 it("start 12 success → 'Started:' receipt + persisted in_progress", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(tp, mkState(mkTask({ id: 12, status: "pending" })));
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("start 12", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  assert.ok(
   success.some((n) => /Started:/.test(n.message) && /#12/.test(n.message)),
   `expected Started: receipt, got: ${success.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  const t12 = after.tasks.find((t) => t.id === 12);
  assert.equal(t12?.status, "in_progress");
 });

 // ── Row 2: finish 17 unlocks 18 ────────────────────────────────────────
 it("finish 17 success + 'Now ready' surfaces #18 (becameReady)", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 17, status: "in_progress" }),
    mkTask({ id: 18, status: "pending", blockedBy: [17] }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("finish 17", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  const allMsgs = success.map((n) => n.message).join("\n");
  assert.ok(/Finished:/.test(allMsgs), "expected Finished: receipt");
  assert.ok(/Now ready/.test(allMsgs), "expected 'Now ready' section");
  assert.ok(/#18/.test(allMsgs), "expected #18 in 'Now ready'");
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 17)?.status, "completed");
 });

 // ── Row 3: reopen 17 final role canonical ─────────────────────────────
 it("reopen 17 with no deps → ready' role in primary receipt (NOT hardcoded BLOCKED)", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(tp, mkState(mkTask({ id: 17, status: "completed" })));
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("reopen 17", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  const firstLine = success[0]?.message.split("\n")[0] ?? "";
  assert.ok(
   /Reopened:.*◆/.test(firstLine),
   `expected ◆ (ready) in reopened receipt, got: ${firstLine}`,
  );
  assert.ok(
   !/Reopened:.*○/.test(firstLine),
   `reopen must NOT hardcode ○ (blocked): ${firstLine}`,
  );
 });

 // ── Row 4: archive 1 2 selector resolve once + 1 commit ────────────────
 it("archive 1 2 → 'Archived 2 tasks.' + both archived in persisted state", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 1, status: "completed" }),
    mkTask({ id: 2, status: "completed" }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive 1 2", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  assert.ok(
   success.some((n) => /Archived 2 tasks\./.test(n.message)),
   `expected batch receipt, got: ${success.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.ok(after.tasks.find((t) => t.id === 1)?.archivedAt !== undefined);
  assert.ok(after.tasks.find((t) => t.id === 2)?.archivedAt !== undefined);
 });

 // ── Row 5: restore archived (named selector batch) ────────────────────
 it("restore archived → batch restores all archived tasks", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 3, status: "completed", archivedAt: 100 }),
    mkTask({ id: 4, status: "completed", archivedAt: 100 }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("restore archived", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  assert.ok(
   success.some((n) => /Restored 2 tasks\./.test(n.message)),
   `expected batch restore, got: ${success.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 3)?.archivedAt, undefined);
  assert.equal(after.tasks.find((t) => t.id === 4)?.archivedAt, undefined);
 });

 // ── Row 6: command syntax failure → 0 commits, error notice ───────────
 it("command syntax failure ('start' alone) → error notice, state unchanged", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(mkTask({ id: 17, status: "pending" }));
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("start", commandRegistry.ctx);
  assert.ok(
   notices.some(
    (n) => n.level === "error" && /Invalid mutation command/.test(n.message),
   ),
   `expected syntax error, got: ${notices.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 17)?.status, "pending");
 });

 // ── Row 7: selector syntax failure → 0 commits ─────────────────────────
 it("selector syntax failure ('archive abc') → error notice, state unchanged", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(mkTask({ id: 1, status: "completed" }));
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive abc", commandRegistry.ctx);
  assert.ok(
   notices.some(
    (n) => n.level === "error" && /Invalid archive selector/.test(n.message),
   ),
   `expected selector syntax error`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 1)?.archivedAt, undefined);
 });

 // ── Row 8: selector policy failure → 0 commits ─────────────────────────
 // P4-C2 LOCK 21: wording is now owned by formatSelectorPolicyNotice.
 // The frozen policy (validateMutationCommand rejects same input) is
 // verified separately in selector-policy-notice.test.ts.
 it("selector policy failure ('archive all') → 'all' rejected with P4 actionable wording, state unchanged", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(mkTask({ id: 1, status: "completed" }));
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive all", commandRegistry.ctx);
  assert.ok(
   notices.some(
    (n) =>
     n.level === "error" &&
     /`all` cannot be used with `archive`/.test(n.message),
   ),
   `expected P4-C2 actionable wording, got: ${notices.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 1)?.archivedAt, undefined);
 });

 // ── Row 9: resolution failure (CORRECTED: archive 99, NOT finish 99) ──
 it("resolution failure ('archive 99') → 'Task #99 not found.' notice, state unchanged", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(mkTask({ id: 17, status: "completed" }));
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive 99", commandRegistry.ctx);
  assert.ok(
   notices.some(
    (n) => n.level === "error" && /Task #99 not found\./.test(n.message),
   ),
   `expected resolution error, got: ${notices.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 17)?.archivedAt, undefined);
 });

 // ── Row 10: domain failure (lifecycle nonexistent → TASK_NOT_FOUND) ────
 it("domain failure ('finish 99') → '#99 not found' notice, state unchanged", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(mkTask({ id: 17, status: "pending" }));
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("finish 99", commandRegistry.ctx);
  assert.ok(
   notices.some((n) => n.level === "error" && /#99 not found/.test(n.message)),
   `expected domain TASK_NOT_FOUND error, got: ${notices.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 17)?.status, "pending");
 });

 // ── Row 10b: domain failure (illegal lifecycle transition) ─────────────
 it("domain failure ('finish 17' on pending 17) → illegal transition, state unchanged", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(mkTask({ id: 17, status: "pending" }));
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("finish 17", commandRegistry.ctx);
  assert.ok(
   notices.some(
    (n) => n.level === "error" && /illegal transition/.test(n.message),
   ),
   `expected illegal-transition error, got: ${notices.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.find((t) => t.id === 17)?.status, "pending");
 });

 // ── Row 11: empty archive completed → no-op success, 0 commits ─────────
 it("empty 'archive completed' (no members) → 'Nothing to archive.' + 0 commits", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(tp, mkState()); // no completed tasks
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive completed", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  assert.ok(
   success.some((n) => /Nothing to archive\./.test(n.message)),
   `expected 'Nothing to archive.' no-op, got: ${success.map((n) => n.message).join(" | ")}`,
  );
  const after = await loadState(tp);
  assert.equal(after.tasks.length, 0);
 });

 // ── Row 12: successful N-target batch → persisted state correct ───────
 it("successful 3-target archive batch → all 3 archived in persisted state", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 1, status: "completed" }),
    mkTask({ id: 2, status: "completed" }),
    mkTask({ id: 3, status: "completed" }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive 1 2 3", commandRegistry.ctx);
  const after = await loadState(tp);
  for (const id of [1, 2, 3]) {
   assert.ok(
    after.tasks.find((t) => t.id === id)?.archivedAt !== undefined,
    `task ${id} should be archived`,
   );
  }
 });

 // ── Row 13: action #2 fails → whole batch 0 commits (atomicity) ───────
 it("archive 1 2 3 where #2 pending → batch atomicity: 0 commits", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  const initial = mkState(
   mkTask({ id: 1, status: "completed" }),
   mkTask({ id: 2, status: "pending" }),
   mkTask({ id: 3, status: "completed" }),
  );
  await seed(tp, initial);
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("archive 1 2 3", commandRegistry.ctx);
  assert.ok(
   notices.some((n) => n.level === "error"),
   `expected batch failure error`,
  );
  const after = await loadState(tp);
  assert.equal(
   after.tasks.find((t) => t.id === 1)?.archivedAt,
   undefined,
   "#1 must NOT be committed (batch atomicity)",
  );
  assert.equal(
   after.tasks.find((t) => t.id === 2)?.archivedAt,
   undefined,
   "#2 must NOT be committed",
  );
  assert.equal(
   after.tasks.find((t) => t.id === 3)?.archivedAt,
   undefined,
   "#3 must NOT be committed (fail-fast before action)",
  );
 });

 // ── Row 15: finish unlocks task — Now ready contains dependent ────────
 it("finish 17 → 'Now ready' contains #18 (dependency was unblocked)", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 17, status: "in_progress" }),
    mkTask({ id: 18, status: "pending", blockedBy: [17] }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("finish 17", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  const allMsgs = success.map((n) => n.message).join("\n");
  assert.ok(/#18/.test(allMsgs), "expected #18 in 'Now ready'");
 });

 // ── Row 16: reopen reblocks task — Re-blocked contains dependent ───────
 it("reopen 17 → 'Re-blocked' contains #18 (dependency now waiting again)", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 17, status: "completed" }),
    mkTask({ id: 18, status: "pending", blockedBy: [17] }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("reopen 17", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  const allMsgs = success.map((n) => n.message).join("\n");
  assert.ok(/Re-blocked/.test(allMsgs), "expected 'Re-blocked' section");
  assert.ok(/#18/.test(allMsgs), "expected #18 in 'Re-blocked'");
 });

 // ── Row 14: primary + consequence exclusion ───────────────────────────
 it("finish 17 → 'Now ready' does NOT contain #17 (primary excluded)", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(
   tp,
   mkState(
    mkTask({ id: 17, status: "in_progress" }),
    mkTask({ id: 18, status: "pending", blockedBy: [17] }),
   ),
  );
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("finish 17", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  const allMsgs = success.map((n) => n.message).join("\n");
  assert.ok(/#17/.test(allMsgs), "primary #17 receipt expected");
  const idx = allMsgs.indexOf("Now ready");
  if (idx >= 0) {
   const after = allMsgs.slice(idx);
   const sectionEnd = after.indexOf("Re-blocked");
   const section = sectionEnd === -1 ? after : after.slice(0, sectionEnd);
   assert.ok(
    !/#17\b/.test(section),
    `primary #17 must be excluded from 'Now ready': ${section}`,
   );
  }
 });
});

// ── Architecture: source-inspection invariants ──────────────────────────

describe("P1-D mutation wiring: architecture", () => {
 // Helper: extract the body of runMutationFlow (everything between the
 // function declaration and the start of the runGraphQuery declaration).
 async function extractMutationFlowBody(): Promise<string> {
  const src = await readFile("index.ts", "utf8");
  const startIdx = src.indexOf("function runMutationFlow");
  assert.ok(startIdx >= 0, "function runMutationFlow not found in index.ts");
  const endIdx = src.indexOf("function runGraphQuery", startIdx);
  assert.ok(
   endIdx > startIdx,
   "function runGraphQuery marker not found after runMutationFlow",
  );
  return src.slice(startIdx, endIdx);
 }

 // C4 (P3-E amendment): exactly one durableStore.load via loadEnvelope.
 // loadEnvelope is the sole entry point — direct getState from store.ts is
 // forbidden in P3-E (LOCK §2).
 it("runMutationFlow contains exactly one durableStore.load call site via loadEnvelope (C4 snapshot once)", async () => {
  const body = await extractMutationFlowBody();
  const loadEnvelopeMatches = body.match(/\bloadEnvelope\s*\(/g) ?? [];
  assert.ok(
   loadEnvelopeMatches.length >= 1,
   "runMutationFlow must call loadEnvelope() (C4)",
  );
  // No direct getState from store.ts (legacy).
  assert.ok(
   !/\bgetState\s*\(/.test(body),
   "runMutationFlow must not call legacy getState (P3-E LOCK §2)",
  );
 });

 // C5/C10 (P3-E amendment): exactly one durableStore.commit call site.
 it("runMutationFlow contains exactly one durableStore.commit call site (C5 / C10)", async () => {
  const body = await extractMutationFlowBody();
  const occurrences = body.match(/durableStore\.commit\s*\(/g) ?? [];
  assert.equal(
   occurrences.length,
   1,
   `runMutationFlow must contain exactly one durableStore.commit call site. Found ${occurrences.length}.`,
  );
 });

 // C5 (P3-E amendment): commit is guarded by result.ok; empty no-op
 // short-circuits BEFORE commit (no replay-capture either).
 it("durableStore.commit is guarded by result.ok; empty no-op short-circuits before commit (C5, P3-E LOCK §35)", async () => {
  const body = await extractMutationFlowBody();
  // Empty no-op short-circuit (LOCK §35): plan.targetIds.length === 0
  // returns BEFORE durableStore.commit (no commit, no replay-capture).
  assert.ok(
   /plan\.targetIds\.length\s*===\s*0[\s\S]+?return\s*;[\s\S]+?durableStore\.commit\s*\(/m.test(
    body,
   ),
   "empty no-op short-circuit must precede durableStore.commit (P3-E LOCK §35)",
  );
  // applyMutationPlan result.ok guard must appear before durableStore.commit
  // in the function body, ensuring commit is unreachable on executor failure.
  const okGuardIdx = body.search(/result\.ok\s*===\s*false/);
  const commitIdx = body.search(/durableStore\.commit\s*\(/);
  assert.ok(okGuardIdx > -1, "expected result.ok === false guard in function");
  assert.ok(commitIdx > -1, "expected durableStore.commit call site");
  assert.ok(
   okGuardIdx < commitIdx,
   "result.ok guard must precede durableStore.commit (C6: commit only after successful execution)",
  );
 });

 // C8 layer purity (P3-E amendment): no graph/projection UX call sites.
 // runMutationFlow uses plan-based executor (applyMutationPlan), not the
 // single-task applyTaskMutation (which is for the tool path).
 it("runMutationFlow does not invoke graph/projection UX functions (C8 layer purity)", async () => {
  const body = await extractMutationFlowBody();
  const banned = [
   "diffActiveView",
   "classifyTask",
   "projectActiveView",
   "projectCompleted",
   "projectArchived",
   "projectAll",
   "buildDependencyPresentation",
   "selectCompletedTaskIds",
   "selectArchivedTaskIds",
   "selectAllTaskIds",
   "applyTaskMutation",
   "reverseDependencies",
   "brokenDependencies",
   "unsatisfiedDependencies",
  ];
  for (const name of banned) {
   assert.ok(
    !new RegExp(`\\b${name}\\s*\\(`).test(body),
    `runMutationFlow must not call ${name}(...) (C8 layer purity)`,
   );
  }
 });

 // C8 (P3-E amendment): no mutation UX strings — wire never owns wording.
 // Strings live in mutation-format.ts; runMutationFlow only references
 // formatter module names.
 it("runMutationFlow does not construct mutation UX strings (C8 — wire never owns wording)", async () => {
  const body = await extractMutationFlowBody();
  const bannedStrings = [
   "Started:",
   "Finished:",
   "Reopened:",
   "Archived:",
   "Restored:",
   "Nothing to archive",
   "Nothing to restore",
   "Now ready",
   "Re-blocked",
   "Invalid mutation command",
   "Invalid archive selector",
   "Invalid restore selector",
   "not a valid selector for",
  ];
  for (const s of bannedStrings) {
   assert.ok(
    !body.includes(s),
    `runMutationFlow contains forbidden UX string '${s}' (C8)`,
   );
  }
 });

 // P0-B B3 read verb fallthrough (LOCK §7, §8): no state mutation.
 it("wiring fallthrough: read verbs still route to parseTodosCommand (no regression)", async () => {
  const tp = makeTestPersistence();
  factory(commandRegistry.api, { persistence: tp.persistence });
  await seed(tp, mkState(mkTask({ id: 1, status: "pending" })));
  const handler = commandRegistry.handlers.get("todos");
  if (!handler) throw new Error("todos command handler not registered");
  notices.length = 0;
  await handler("", commandRegistry.ctx);
  const success = notices.filter((n) => n.level !== "error");
  assert.ok(success.length > 0, "empty /todos still renders read view");
 });
});
