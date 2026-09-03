/**
 * task-detail-format.test.ts — P4-C2 (rich task detail tests).
 *
 * Verifies:
 *   A. `queryWhyTask` is the sole classification authority (LOCK 18).
 *   B. Frozen `formatWhyTask` is the canonical semantic body
 *      (LOCK 25, 26) — no P4 re-render of primary row or blocker
 *      markers.
 *   C. `Task.description` is surfaced (presentation data, LOCK 28).
 *   D. Direct unlocks appended for active classifications only
 *      (LOCK 9).
 *   E. Negative: NO `Status:` / `State:` / `Required by:` / `metadata`
 *      / `owner` / `archivedAt` / `revision` / `createdAt` /
 *      `updatedAt` (LOCK 19, 20, 28).
 *   F. Architecture: file does NOT import `reverseDependencies`,
 *      `graph.ts`, or `formatTaskDetail` (LOCK 19, 25, 26).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { formatTaskDetailRich } from "./task-detail-format.ts";
import { queryWhyTask } from "./graph-query.ts";
import { formatWhyTask } from "./graph-format.ts";
import type { Task, TaskState } from "./types.ts";

function mk(
 id: number,
 sub: string,
 status: Task["status"] = "pending",
 extras: Partial<Task> = {},
): Task {
 return {
  id,
  subject: sub,
  status,
  createdAt: 0,
  updatedAt: 0,
  ...extras,
 };
}

// ── A. not-found path ─────────────────────────────────────────────

describe("task-detail-format: not-found", () => {
 it("non-existent id → 'Task #N not found.' (verbatim frozen output)", () => {
  const state: TaskState = { tasks: [], nextId: 1 };
  const lines = formatTaskDetailRich(state, 999, 80);
  // Verbatim equality with frozen formatWhyTask(not-found, width).
  assert.deepEqual(lines, formatWhyTask(queryWhyTask(state, 999), 80));
 });

 it("deleted task → 'Task #N not found.' (deleted treated as not-found by P2-A)", () => {
  const state: TaskState = {
   tasks: [mk(17, "deleted", "deleted")],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  assert.match(lines[0]!, /^Task #17 not found\.$/);
 });
});

// ── B. semantic body = frozen formatWhyTask verbatim ─────────────

describe("task-detail-format: semantic body provenance (LOCK 25, 26)", () => {
 it("ready task → first lines equal formatWhyTask output", () => {
  const state: TaskState = {
   tasks: [mk(17, "Implement cache", "pending")],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const frozen = formatWhyTask(queryWhyTask(state, 17), 80);
  // The semantic body is the frozen formatWhyTask output. The P4
  // additions (description / unlocks) are appended AFTER, so the
  // first N lines must equal the frozen output exactly.
  const frozenLen = frozen.length;
  assert.deepEqual(lines.slice(0, frozenLen), frozen);
 });

 it("blocked task → first lines include frozen 'Blocked by:' section", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "y", "pending", { blockedBy: [12] }),
    mk(12, "missing dep", "pending"),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  assert.match(out, /Blocked by/);
  assert.match(out, /#12/);
  // The frozen formatWhyTask output must be present verbatim.
  const frozen = formatWhyTask(queryWhyTask(state, 17), 80);
  assert.deepEqual(
   lines.slice(0, frozen.length),
   frozen,
   "frozen formatWhyTask must be embedded verbatim as the body",
  );
 });
});

// ── C2. P4-D fix: no duplicate canonical task row ────────────────────
//
// When a task has BOTH a description AND direct unlocks, the
// canonical task row must appear exactly once. The frozen
// formatWhyTask head AND the frozen formatUnlocksTask head both
// contain the same row; P4 composition must dedup.
//
// This is a real daily friction that the P4-D audit caught:
// `formatUnlocksTask` output starts with the head, so embedding
// the full output would duplicate the row already in semanticBody.

describe("task-detail-format: no duplicate canonical row (P4-D fix)", () => {
 it("running task with description + direct unlocks → task row appears exactly once", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Implement cache bootstrap", "in_progress", {
     description:
      "Restore the workspace todo overlay from durable state after /reload.",
    }),
    mk(21, "Integration tests", "pending", { blockedBy: [17] }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  const rowMatches = out.match(/▶ #17 Implement cache bootstrap/g) ?? [];
  assert.equal(
   rowMatches.length,
   1,
   `expected exactly 1 occurrence of canonical row, found ${rowMatches.length}:\n${out}`,
  );
  assert.match(out, /Restore the workspace todo overlay/);
  assert.match(out, /Completing this task would make ready/);
  assert.match(out, /◆ #21 Integration tests/);
 });

 it("ready task with direct unlocks (no description) → task row appears exactly once", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Parse doc", "pending"),
    mk(21, "Build index", "pending", { blockedBy: [17] }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  const rowMatches = out.match(/◆ #17 Parse doc/g) ?? [];
  assert.equal(rowMatches.length, 1);
 });

 it("blocked task with direct unlocks (no description) → task row appears exactly once", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "downstream", "pending", { blockedBy: [12] }),
    mk(12, "x", "pending"),
    mk(21, "y", "pending", { blockedBy: [17] }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  const rowMatches = out.match(/○ #17 downstream/g) ?? [];
  assert.equal(rowMatches.length, 1);
 });
});

// ── C. description surfacing ──────────────────────────────────────

describe("task-detail-format: Task.description (LOCK 28)", () => {
 it("task with description → description block appended after frozen body", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Implement cache", "pending", {
     description:
      "Restore the workspace todo overlay from durable state after /reload.",
    }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  assert.match(out, /Restore the workspace todo overlay/);
  // Description is appended after the frozen body — there must be a
  // blank line between body and description.
  const frozen = formatWhyTask(queryWhyTask(state, 17), 80);
  const idx = lines.indexOf("");
  assert.ok(
   idx >= frozen.length,
   "blank line must separate body from description",
  );
 });

 it("task WITHOUT description → no description block", () => {
  const state: TaskState = {
   tasks: [mk(17, "Implement cache", "pending")],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const frozen = formatWhyTask(queryWhyTask(state, 17), 80);
  assert.deepEqual(lines, frozen);
 });
});

// ── D. unlocks appended for active classifications ───────────────

describe("task-detail-format: direct unlocks (LOCK 9)", () => {
 it("ready task with direct dependents → unlocks appended", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Parse doc", "pending"),
    mk(21, "Build index", "pending", { blockedBy: [17] }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  assert.match(out, /Completing this task would make ready/);
  assert.match(out, /Build index/);
 });

 it("completed task → NO unlocks (no completion consequence)", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Already done", "completed"),
    mk(21, "Build index", "pending", { blockedBy: [17] }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  assert.doesNotMatch(out, /Completing this task would make ready/);
 });

 it("archived task → NO unlocks", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "old", "completed", { archivedAt: 100 }),
    mk(21, "Build index", "pending", { blockedBy: [17] }),
   ],
   nextId: 100,
  };
  const lines = formatTaskDetailRich(state, 17, 80);
  const out = lines.join("\n");
  assert.doesNotMatch(out, /Completing this task would make ready/);
 });
});

// ── E. Negative: forbidden strings (LOCK 19, 20, 28) ─────────────

describe("task-detail-format: forbidden content", () => {
 const state: TaskState = {
  tasks: [
   mk(17, "Implement cache", "in_progress", {
    description: "Long description that goes across the page width.",
    metadata: { priority: "high" },
    owner: "alice",
    createdAt: 1000,
    updatedAt: 2000,
   }),
  ],
  nextId: 100,
 };

 it("NO 'Status:' line", () => {
  const out = formatTaskDetailRich(state, 17, 80).join("\n");
  assert.doesNotMatch(out, /Status:/);
 });

 it("NO 'State:' line", () => {
  const out = formatTaskDetailRich(state, 17, 80).join("\n");
  assert.doesNotMatch(out, /State:/);
 });

 it("NO 'Required by:' section", () => {
  const out = formatTaskDetailRich(state, 17, 80).join("\n");
  assert.doesNotMatch(out, /Required by/);
 });

 it("NO raw metadata dump", () => {
  const out = formatTaskDetailRich(state, 17, 80).join("\n");
  assert.doesNotMatch(out, /priority/);
  assert.doesNotMatch(out, /high/);
  assert.doesNotMatch(out, /metadata/);
 });

 it("NO owner field", () => {
  const out = formatTaskDetailRich(state, 17, 80).join("\n");
  assert.doesNotMatch(out, /alice/);
  assert.doesNotMatch(out, /owner/i);
 });

 it("NO timestamp / revision dump", () => {
  const out = formatTaskDetailRich(state, 17, 80).join("\n");
  assert.doesNotMatch(out, /createdAt/);
  assert.doesNotMatch(out, /updatedAt/);
  assert.doesNotMatch(out, /archivedAt/);
  assert.doesNotMatch(out, /\brevision\b/);
 });
});

// ── F. Architecture: forbidden imports (LOCK 19, 25, 26) ─────────

describe("task-detail-format: architecture lock", () => {
 it("does NOT import reverseDependencies, graph.ts, or formatTaskDetail", async () => {
  const src = await readFile("task-detail-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
   !/\breverseDependencies\b/.test(code),
   "task-detail-format must not import reverseDependencies (LOCK 19)",
  );
  assert.ok(
   !/\bfrom\s+["']\.\/graph(?:\.ts)?["']/.test(code),
   "task-detail-format must not import from graph.ts (LOCK 19 — no Required by)",
  );
  assert.ok(
   !/\bformatTaskDetail\b/.test(code),
   "task-detail-format must not import formatTaskDetail (LOCK 25 — no duplicate canonical body)",
  );
 });

 it("raw Task access: only .id and .description are referenced", async () => {
  const src = await readFile("task-detail-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // The module must access task.id (for lookup) and task.description
  // (for the decoration). It must NOT reference any other lifecycle /
  // readiness / dependency field.
  assert.ok(
   /\btask\.id\b/.test(code) || /\bt\.id\b/.test(code),
   "expected raw Task .id access for lookup",
  );
  assert.ok(
   /\btask\.description\b/.test(code) || /\bt\.description\b/.test(code),
   "expected raw Task .description access for the decoration line",
  );
  // Negative: no other Task fields.
  assert.ok(
   !/\btask\.status\b/.test(code) && !/\bt\.status\b/.test(code),
   "must not read task.status (LOCK 18, 28)",
  );
  assert.ok(
   !/\btask\.archivedAt\b/.test(code) && !/\bt\.archivedAt\b/.test(code),
   "must not read task.archivedAt (LOCK 18, 28)",
  );
  assert.ok(
   !/\btask\.blockedBy\b/.test(code) && !/\bt\.blockedBy\b/.test(code),
   "must not read task.blockedBy (LOCK 18, 28)",
  );
 });

 // P4-D LOCK D3: P4 formatters MUST NOT structurally parse, slice,
 // index, regex-match, or otherwise decompose string[] returned by
 // frozen P0-P3 formatters. Frozen formatter output is terminal
 // presentation, not a composable AST. When P4 needs a presentation
 // subset, it MUST compose from the frozen typed result + public
 // row-level primitives (e.g. `formatTaskRow`), without re-deriving
 // semantic facts.
 it("LOCK D3: no .slice() / .splice() / .findIndex() / .indexOf() applied to formatter output", async () => {
  const src = await readFile("task-detail-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const bannedStructural = [
   { pattern: /\.slice\(/, label: ".slice(" },
   { pattern: /\.splice\(/, label: ".splice(" },
   { pattern: /\.findIndex\(/, label: ".findIndex(" },
  ];
  for (const { pattern, label } of bannedStructural) {
   assert.ok(
    !pattern.test(code),
    `task-detail-format must not call ${label} — frozen formatter output is terminal, not an AST (LOCK D3)`,
   );
  }
 });

 it("LOCK D3: does not import or call frozen formatUnlocksTask (uses direct-unlock-format instead)", async () => {
  const src = await readFile("task-detail-format.ts", "utf8");
  assert.ok(
   !/\bformatUnlocksTask\b/.test(src),
   "task-detail-format must not import / call formatUnlocksTask (LOCK D3: composition via typed result, not formatter string[] decomposition)",
  );
  // It SHOULD use the P4-D typed-result composition module.
  assert.ok(
   /\bformatDirectUnlockConsequences\b/.test(src),
   "expected task-detail-format to use formatDirectUnlockConsequences (typed-result composition)",
  );
 });

 it("LOCK D3: imports the new P4-D composition module (typed-result based)", async () => {
  const src = await readFile("task-detail-format.ts", "utf8");
  assert.ok(
   /\bfrom\s+["']\.\/direct-unlock-format(?:\.ts)?["']/.test(src),
   "expected import from './direct-unlock-format.ts'",
  );
 });
});
