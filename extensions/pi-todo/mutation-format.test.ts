/**
 * Unit tests for mutation-format.ts (P1-C formatting).
 *
 * Critical invariants tested:
 *   1. formatMutationOutcome never receives TaskState.
 *   2. Reopened target presentation is CANONICAL (not hardcoded BLOCKED).
 *   3. Empty named selector → "Nothing to archive." / "Nothing to restore.".
 *   4. Primary targets excluded from secondary consequences.
 *   5. Consequence order preserved (no re-sort).
 *   6. Empty consequence sections omitted.
 *   7. formatMutationError renders all 5 error layers.
 *   8. Layer purity: does not import graph/projection/reducer/store/
 *      read-model/mutation-command/mutation-selector/mutation-executor.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { buildMutationOutcome } from "./mutation-outcome.ts";
import { buildMutationPlan } from "./mutation-executor.ts";
import { diffActiveView } from "./projection.ts";
import {
 formatMutationError,
 formatMutationOutcome,
 type MutationCliError,
} from "./mutation-format.ts";
import { normalizeTask } from "./types.ts";
import type { MutationCommand, MutationError, TaskState } from "./types.ts";

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

const WIDTH = 80;

// ── Primary receipt: single target ──────────────────────────────────────

describe("formatMutationOutcome: single target primary receipt", () => {
 it("start #17 → 'Started:  ▶ #17 ...'", () => {
  const prev = mkState(mkTask({ id: 17, status: "pending" }));
  const next = mkState(mkTask({ id: 17, status: "in_progress", updatedAt: 1 }));
  const plan = buildMutationPlan(
   { kind: "start", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.ok(lines[0]?.startsWith("Started:"), `actual: ${lines[0]}`);
  assert.match(lines[0]!, /▶/);
  assert.match(lines[0]!, /#17/);
 });

 it("finish #17 → 'Finished:  ✓ #17 ...'", () => {
  const prev = mkState(mkTask({ id: 17, status: "in_progress" }));
  const next = mkState(mkTask({ id: 17, status: "completed" }));
  const plan = buildMutationPlan(
   { kind: "finish", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.ok(lines[0]?.startsWith("Finished:"), `actual: ${lines[0]}`);
  assert.match(lines[0]!, /✓/);
  assert.match(lines[0]!, /#17/);
 });

 it("★ reopen #17 with NO deps → 'Reopened:  ◆ #17 ...' (ready, NOT blocked)", () => {
  // After reopen, #17 is pending with no deps → ready
  const prev = mkState(mkTask({ id: 17, status: "completed" }));
  const next = mkState(mkTask({ id: 17, status: "pending" }));
  const plan = buildMutationPlan(
   { kind: "reopen", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.ok(lines[0]?.startsWith("Reopened:"), `actual: ${lines[0]}`);
  assert.match(lines[0]!, /◆/); // ready icon, NOT blocked
  assert.doesNotMatch(lines[0]!, /○/);
 });

 it("★ reopen #17 WITH unsatisfied dep → 'Reopened:  ○ #17 ...' (blocked, canonical)", () => {
  // After reopen, #17 is pending with dep on #18 (still pending) → blocked
  const prev = mkState(
   mkTask({ id: 17, status: "completed", blockedBy: [18] }),
   mkTask({ id: 18, status: "pending" }),
  );
  const next = mkState(
   mkTask({ id: 17, status: "pending", blockedBy: [18], updatedAt: 1 }),
   mkTask({ id: 18, status: "pending" }),
  );
  const plan = buildMutationPlan(
   { kind: "reopen", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.ok(lines[0]?.startsWith("Reopened:"), `actual: ${lines[0]}`);
  assert.match(lines[0]!, /○/); // blocked icon, canonical
 });

 it("archive #17 single → 'Archived:  · #17 ...' (archived role)", () => {
  const prev = mkState(mkTask({ id: 17, status: "completed" }));
  const next = mkState(
   mkTask({ id: 17, status: "completed", archivedAt: 100 }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [17] },
   } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.ok(lines[0]?.startsWith("Archived:"), `actual: ${lines[0]}`);
  assert.match(lines[0]!, /·/);
 });

 it("restore #17 single → 'Restored:  ✓ #17 ...' (completed role)", () => {
  const prev = mkState(
   mkTask({ id: 17, status: "completed", archivedAt: 100 }),
  );
  const next = mkState(mkTask({ id: 17, status: "completed" }));
  const plan = buildMutationPlan(
   {
    kind: "restore",
    selector: { kind: "ids", ids: [17] },
   } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.ok(lines[0]?.startsWith("Restored:"), `actual: ${lines[0]}`);
  assert.match(lines[0]!, /✓/);
 });
});

// ── Primary receipt: batch ─────────────────────────────────────────────

describe("formatMutationOutcome: batch primary receipt", () => {
 it("archive 3 tasks → 'Archived 3 tasks.' (no per-task list)", () => {
  const prev = mkState(
   mkTask({ id: 1, status: "completed" }),
   mkTask({ id: 2, status: "completed" }),
   mkTask({ id: 3, status: "completed" }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "completed", archivedAt: 100 }),
   mkTask({ id: 2, status: "completed", archivedAt: 100 }),
   mkTask({ id: 3, status: "completed", archivedAt: 100 }),
  );
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [1, 2, 3] },
   } as MutationCommand,
   [1, 2, 3],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.equal(lines[0], "Archived 3 tasks.");
  // No per-task list (would crowd the CLI)
  assert.ok(
   !lines.some((l) => l.includes("#1")),
   "no per-task subject printed",
  );
 });
});

// ── Empty named selector (no-op) ────────────────────────────────────────

describe("formatMutationOutcome: empty targetIds (no-op)", () => {
 it("archive 0 tasks → 'Nothing to archive.'", () => {
  const state = mkState();
  const plan = buildMutationPlan(
   {
    kind: "archive",
    selector: { kind: "ids", ids: [] },
   } as MutationCommand,
   [],
  );
  const out = buildMutationOutcome(state, state, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.deepEqual(lines, ["Nothing to archive."]);
 });

 it("restore 0 tasks → 'Nothing to restore.'", () => {
  const state = mkState();
  const plan = buildMutationPlan(
   {
    kind: "restore",
    selector: { kind: "ids", ids: [] },
   } as MutationCommand,
   [],
  );
  const out = buildMutationOutcome(state, state, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  assert.deepEqual(lines, ["Nothing to restore."]);
 });
});

// ── Secondary consequences ────────────────────────────────────────────

describe("formatMutationOutcome: secondary consequences", () => {
 it("finish #1 → 'Now ready' section for #2 (becameReady)", () => {
  const prev = mkState(
   mkTask({ id: 1, status: "in_progress" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "completed", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const plan = buildMutationPlan(
   { kind: "finish", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  const idx = lines.indexOf("Now ready");
  assert.notEqual(idx, -1, "Now ready section expected");
  assert.match(lines[idx + 1] ?? "", /◆ #2/);
 });

 it("reopen #1 → 'Re-blocked' section for #2 (becameBlocked)", () => {
  const prev = mkState(
   mkTask({ id: 1, status: "completed" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "pending", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const plan = buildMutationPlan(
   { kind: "reopen", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  const idx = lines.indexOf("Re-blocked");
  assert.notEqual(idx, -1, "Re-blocked section expected");
  assert.match(lines[idx + 1] ?? "", /○ #2/);
  // Re-blocked section must show deps from depsMap
  assert.match(lines[idx + 1] ?? "", /←/);
 });

 it("★ primary target excluded from secondary consequences", () => {
  // finish #1: #1 leaves active; #2 (was blocked) becomes ready.
  // #1 is the primary target — must NOT appear in Now ready.
  const prev = mkState(
   mkTask({ id: 1, status: "in_progress" }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const next = mkState(
   mkTask({ id: 1, status: "completed", updatedAt: 1 }),
   mkTask({ id: 2, status: "pending", blockedBy: [1] }),
  );
  const plan = buildMutationPlan(
   { kind: "finish", id: 1 } as MutationCommand,
   [1],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  // #2 is in Now ready
  assert.ok(lines.some((l) => /#2/.test(l)));
  // #1 is NOT in Now ready (it's the primary target; would be in primary receipt)
  const nowReadyIdx = lines.indexOf("Now ready");
  if (nowReadyIdx >= 0) {
   for (const l of lines.slice(nowReadyIdx + 1)) {
    assert.ok(
     !/#1\b/.test(l),
     `#1 (primary) must not appear in Now ready: ${l}`,
    );
   }
  }
 });

 it("★ consequence order preserved (no re-sort)", () => {
  // Build a state where completing the gating dep #100 makes #3, #1, #2 ready
  // in insertion order. Formatter must render them in the same order.
  const prev = mkState(
   mkTask({ id: 100, status: "in_progress" }),
   mkTask({ id: 3, status: "pending", blockedBy: [100] }),
   mkTask({ id: 1, status: "pending", blockedBy: [100] }),
   mkTask({ id: 2, status: "pending", blockedBy: [100] }),
  );
  const next = mkState(
   mkTask({ id: 100, status: "completed", updatedAt: 1 }),
   mkTask({ id: 3, status: "pending", blockedBy: [100] }),
   mkTask({ id: 1, status: "pending", blockedBy: [100] }),
   mkTask({ id: 2, status: "pending", blockedBy: [100] }),
  );
  // Verify diff preserves projection's canonical sort (id asc by default).
  // Projection sorts READY by createdAt asc, id asc. With createdAt=0 the
  // tiebreak is id asc → [1, 2, 3], not insertion order.
  const diff = diffActiveView(prev, next);
  const readyIds = diff.becameReady.map((t) => t.id);
  assert.deepEqual(
   readyIds,
   [1, 2, 3],
   "projection sorts becameReady by canonical criteria (id asc tiebreak)",
  );

  // Now verify the formatter renders them in the same order
  const plan = buildMutationPlan(
   { kind: "finish", id: 100 } as MutationCommand,
   [100],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  // Find the "Now ready" section and verify the order of the IDs in it
  const startIdx = lines.indexOf("Now ready");
  assert.notEqual(startIdx, -1);
  const afterHeader = lines.slice(startIdx + 1);
  // Extract the IDs in order from the rendered lines
  const renderedIds: number[] = [];
  for (const l of afterHeader) {
   const m = l.match(/#(\d+)/);
   if (m) renderedIds.push(Number(m[1]));
  }
  assert.deepEqual(renderedIds, [1, 2, 3], "formatter preserves diff order");
 });

 it("empty consequence sections omitted (no 'Now ready' header with no rows)", () => {
  // A mutation that produces no membership flip
  const prev = mkState(mkTask({ id: 17, status: "in_progress" }));
  const next = mkState(mkTask({ id: 17, status: "completed", updatedAt: 1 }));
  const plan = buildMutationPlan(
   { kind: "finish", id: 17 } as MutationCommand,
   [17],
  );
  const out = buildMutationOutcome(prev, next, plan);
  const lines = formatMutationOutcome(out, WIDTH);
  // If no diff transition, no "Now ready" / "Re-blocked" header
  assert.ok(
   !lines.some((l) => l === "Now ready" || l === "Re-blocked"),
   "empty sections must be omitted",
  );
 });
});

// ── formatMutationError: 5 error layers ───────────────────────────────

describe("formatMutationError: 5 layer rendering", () => {
 it("command-syntax → usage text", () => {
  const err: MutationCliError = { kind: "command-syntax" };
  const lines = formatMutationError(err);
  assert.ok(lines.some((l) => /Invalid mutation command/.test(l)));
  assert.ok(lines.some((l) => /Usage:/.test(l)));
 });

 it("selector-syntax (archive) → archive-specific guidance", () => {
  const err: MutationCliError = { kind: "selector-syntax", command: "archive" };
  const lines = formatMutationError(err);
  assert.ok(lines.some((l) => /Invalid archive selector/.test(l)));
 });

 it("selector-syntax (restore) → restore-specific guidance", () => {
  const err: MutationCliError = { kind: "selector-syntax", command: "restore" };
  const lines = formatMutationError(err);
  assert.ok(lines.some((l) => /Invalid restore selector/.test(l)));
 });

 it("selector-policy → 'all' rejected for archive", () => {
  const err: MutationCliError = {
   kind: "selector-policy",
   error: { code: "SELECTOR_NOT_ALLOWED", command: "archive", selector: "all" },
  };
  const lines = formatMutationError(err);
  assert.ok(
   lines.some((l) => /`all` is not a valid selector for `archive`/.test(l)),
  );
 });

 it("resolution → '#X not found.'", () => {
  const err: MutationCliError = {
   kind: "resolution",
   notFound: [42, 43],
  };
  const lines = formatMutationError(err);
  assert.match(lines.join(" "), /Task #42, #43 not found/);
 });

 it("domain → forward to translated error", () => {
  const err: MutationCliError = {
   kind: "domain",
   error: {
    code: "TASK_REFERENCED",
    id: 17,
    referencedBy: [18, 22],
   } as MutationError,
   failedTargetId: 17,
  };
  const lines = formatMutationError(err);
  assert.ok(lines.some((l) => /referenced by/.test(l)));
 });
});

// ── Layer purity ────────────────────────────────────────────────────────

describe("mutation-format: layer purity (P1-C)", () => {
 it("does not import graph / projection / reducer / store / read-model / cmd / selector / executor", async () => {
  const src = await readFile("mutation-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
   "./graph",
   "./projection",
   "./reducer",
   "./store",
   "./read-model",
   "./mutation-command",
   "./mutation-selector",
   "./mutation-executor",
  ];
  // mutation-format imports ./mutation-outcome for TYPES ONLY
  // (CommandKind, MutationOutcome, MutationTargetPresentation).
  // No state, no projection read, no business logic.
  for (const p of forbidden) {
   assert.ok(
    !code.includes(p),
    `mutation-format.ts contains forbidden import "${p}"`,
   );
  }
 });

 it("formatMutationOutcome signature: only (outcome, width) — no TaskState in code", async () => {
  const src = await readFile("mutation-format.ts", "utf8");
  // Strip comments (block + line) — they can reference TaskState for docs.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
   !/TaskState/.test(code),
   "mutation-format.ts code must not reference TaskState (state must not cross)",
  );
  // Find the function and check its parameter list specifically
  const fnMatch = code.match(/function formatMutationOutcome\s*\(([^)]*)\)/);
  assert.ok(fnMatch, "formatMutationOutcome must be a function declaration");
  const params = fnMatch![1]!;
  assert.ok(
   !/state/i.test(params),
   `formatMutationOutcome must not accept state parameter, got: ${params}`,
  );
 });

 it("formatMutationError signature: only (error) — pure presentation", async () => {
  const src = await readFile("mutation-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const fnMatch = code.match(/function formatMutationError\s*\(([^)]*)\)/);
  assert.ok(fnMatch, "formatMutationError must be a function declaration");
  const params = fnMatch![1]!.trim();
  assert.ok(
   params.startsWith("error"),
   `formatMutationError must take a single 'error' parameter, got: ${params}`,
  );
  // No more than one parameter
  assert.ok(
   !params.includes(","),
   `formatMutationError must take exactly one parameter, got: ${params}`,
  );
 });
});
