/**
 * current-task-format.test.ts — P4-C2 (`/todos here` formatter tests).
 *
 * Verifies:
 *   A. RUNNING=0 / 1 / >1 output shapes (LOCK 16, 17, 22).
 *   B. RUNNING=0 summary uses frozen `formatNextTasks` output verbatim
 *      — no double `Next:` header (LOCK 24).
 *   C. RUNNING outputs never include a `Blocked by:` section
 *      (LOCK 16, 17 — RUNNING and BLOCKED are mutually exclusive).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatCurrentTask } from "./current-task-format.ts";
import { formatNextTasks, formatUnlocksTask } from "./graph-format.ts";
import { queryNextTasks, queryUnlocksTask } from "./graph-query.ts";
import type { Task, TaskState } from "./types.ts";

function mk(
 id: number,
 sub: string,
 status: Task["status"],
 blockedBy?: number[],
 archivedAt?: number,
): Task {
 return {
  id,
  subject: sub,
  status,
  createdAt: 0,
  updatedAt: 0,
  ...(blockedBy ? { blockedBy } : {}),
  ...(archivedAt === undefined ? {} : { archivedAt }),
 };
}

// ── A. RUNNING = 0 ─────────────────────────────────────────────────

describe("current-task-format: RUNNING = 0", () => {
 it("0 running + 0 ready → single 'No task is currently running.'", () => {
  const state: TaskState = { tasks: [], nextId: 1 };
  const lines = formatCurrentTask(state, 80);
  assert.deepEqual(lines, ["No task is currently running."]);
 });

 it("0 running + 0 ready + archived present → same single line", () => {
  const state: TaskState = {
   tasks: [mk(1, "old", "completed", undefined, 100)],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  assert.deepEqual(lines, ["No task is currently running."]);
 });

 it("0 running + ready present → 'No task...' + 'Next:' + frozen output", () => {
  const state: TaskState = {
   tasks: [mk(18, "Parse document", "pending")],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  assert.equal(lines[0], "No task is currently running.");
  assert.equal(lines[1], "");
  // LOCK 24: formatNextTasks owns its own "Next:" header. P4 must
  // not prepend a duplicate. The frozen output starts with "Next:".
  assert.equal(lines[2], "Next:");
  // The remainder must match the frozen output for the same state.
  const tail = lines.slice(2);
  assert.equal(tail[0], "Next:");
  assert.match(tail.join("\n"), /Parse document/);
 });

 it("0 running + ready → tail equals frozen formatNextTasks output verbatim (LOCK 24)", () => {
  const state: TaskState = {
   tasks: [
    mk(18, "Parse document", "pending"),
    mk(21, "Build index", "pending"),
   ],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  // Drop the first two lines ("No task is currently running." + "").
  const tail = lines.slice(2);
  // Build the expected tail from the frozen formatter on the same state.
  const expectedTail = formatNextTasks(queryNextTasks(state), 80);
  assert.deepEqual(tail, expectedTail);
 });
});

// ── B. RUNNING = 1 ─────────────────────────────────────────────────

describe("current-task-format: RUNNING = 1", () => {
 it("1 running, no direct dependents → 'Current:' + task row", () => {
  const state: TaskState = {
   tasks: [mk(17, "Implement bootstrap", "in_progress")],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  assert.equal(lines[0], "Current:");
  assert.equal(lines[1], "▶ #17 Implement bootstrap");
 });

 it("1 running, has direct dependents → 'Current:' + formatUnlocksTask output", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Implement bootstrap", "in_progress"),
    mk(21, "Integration tests", "pending", [17]),
   ],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  assert.equal(lines[0], "Current:");
  // formatUnlocksTask's head is the task row.
  assert.match(lines[1], /▶ #17/);
  // The unlocks section should follow.
  assert.match(lines.join("\n"), /Completing this task would make ready/);
  assert.match(lines.join("\n"), /Integration tests/);
 });

 it("1 running, direct unlocks present → tail matches formatUnlocksTask verbatim", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Implement bootstrap", "in_progress"),
    mk(21, "Integration tests", "pending", [17]),
   ],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  const expected = formatUnlocksTask(queryUnlocksTask(state, 17), 80);
  // Drop the "Current:" line; the rest must equal frozen output.
  assert.deepEqual(lines.slice(1), expected);
 });
});

// ── C. RUNNING > 1 ────────────────────────────────────────────────

describe("current-task-format: RUNNING > 1", () => {
 it("2 running, neither has dependents → header + both rows, no anomaly claim", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Bootstrap", "in_progress"),
    mk(24, "Fix overlay", "in_progress"),
   ],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  assert.match(lines[0], /^Current: 2 running$/);
  assert.match(lines.join("\n"), /Bootstrap/);
  assert.match(lines.join("\n"), /Fix overlay/);
  // No "anomaly" / "unexpected" / "error" wording.
  assert.doesNotMatch(lines.join("\n"), /anomal|unexpected|error/i);
 });

 it("2 running, one with dependents → both rendered with own unlocks", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Bootstrap", "in_progress"),
    mk(21, "Integration tests", "pending", [17]),
    mk(24, "Fix overlay", "in_progress"),
   ],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  const out = lines.join("\n");
  assert.match(out, /Current: 2 running/);
  assert.match(out, /Bootstrap/);
  assert.match(out, /Fix overlay/);
  assert.match(out, /Integration tests/);
 });
});

// ── D. Negative: NO `Blocked by:` in any RUNNING case (LOCK 16, 17) ─

describe("current-task-format: RUNNING vs BLOCKED are mutually exclusive", () => {
 it("running task with downstream dependents → output has unlocks, NOT blockers", () => {
  const state: TaskState = {
   tasks: [
    mk(17, "Bootstrap", "in_progress"),
    mk(21, "Integration tests", "pending", [17]),
   ],
   nextId: 100,
  };
  const lines = formatCurrentTask(state, 80);
  const out = lines.join("\n");
  assert.doesNotMatch(
   out,
   /Blocked by/,
   "RUNNING task must not show 'Blocked by:' — P2 role model locks RUNNING and BLOCKED as mutually exclusive (LOCK 16, 17)",
  );
 });
});
