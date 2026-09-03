/**
 * Unit tests for overview-format.ts (P4-C1 bounded overview).
 *
 * Verifies:
 *   A. Per-section budgets + overflow lines
 *   B. Empty state preservation
 *   C. Completed-only oracle equality with frozen formatTodosSnapshot
 *   D. Default-budget semantics (omitted vs {} both → 2/3/2)
 *
 * Note: this file imports the frozen `formatTodosSnapshot` from
 * format.ts as the ORACLE for completed-only behavior. The frozen
 * formatter is NOT modified — it's the ground truth for "no active
 * + visible completed" rendering.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatBoundedOverview } from "./overview-format.ts";
import { formatTodosSnapshot } from "./format.ts";
import { projectActiveView } from "./projection.ts";
import type { Task, TaskState } from "./types.ts";

const EMPTY_DEPS: ReadonlyMap<number, readonly never[]> = new Map();

function mk(
 id: number,
 sub: string,
 status: Task["status"],
 blockedBy?: number[],
): Task {
 return {
  id,
  subject: sub,
  status,
  createdAt: 0,
  updatedAt: 0,
  ...(blockedBy ? { blockedBy } : {}),
 };
}

function viewFrom(state: TaskState) {
 return projectActiveView(state);
}

// ── A. Per-section budgets + overflow lines ─────────────────────────────

describe("overview-format: per-section budgets", () => {
 it("RUNNING ≤ 2: 2 running → both shown, no overflow line", () => {
  const state: TaskState = {
   tasks: [mk(1, "task one", "in_progress"), mk(2, "task two", "in_progress")],
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const out = lines.join("\n");
  assert.match(out, /▶ #1 task one/);
  assert.match(out, /▶ #2 task two/);
  assert.doesNotMatch(out, /more running/);
 });

 it("RUNNING > 2: 3 running → top 2 + '+1 more running'", () => {
  const state: TaskState = {
   tasks: [1, 2, 3].map((i) => mk(i, `running ${i}`, "in_progress")),
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const out = lines.join("\n");
  assert.match(out, /▶ #1 running 1/);
  assert.match(out, /▶ #2 running 2/);
  assert.doesNotMatch(out, /▶ #3/);
  assert.match(out, /\+1 more running/);
 });

 it("READY > 3: 18 ready → top 3 + '+15 more ready'", () => {
  const state: TaskState = {
   tasks: Array.from({ length: 18 }, (_, i) =>
    mk(20 + i, `ready ${20 + i}`, "pending"),
   ),
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const out = lines.join("\n");
  assert.match(out, /◆ #20 ready 20/);
  assert.match(out, /◆ #21 ready 21/);
  assert.match(out, /◆ #22 ready 22/);
  assert.doesNotMatch(out, /#23/);
  assert.match(out, /\+15 more ready/);
 });

 it("BLOCKED > 2: 6 blocked → top 2 + '+4 more blocked'", () => {
  const state: TaskState = {
   tasks: [50, 51, 52, 53, 54, 55].map((i) =>
    mk(i, `blocked ${i}`, "pending", [999]),
   ),
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const out = lines.join("\n");
  assert.match(out, /○ #50/);
  assert.match(out, /○ #51/);
  assert.doesNotMatch(out, /#52/);
  assert.match(out, /\+4 more blocked/);
 });

 it("mixed: 5 running + 18 ready + 6 blocked → 2 + 3 + 2 with overflows", () => {
  const state: TaskState = {
   tasks: [
    ...[1, 2, 3, 4, 5].map((i) => mk(i, `r${i}`, "in_progress")),
    ...Array.from({ length: 18 }, (_, i) =>
     mk(20 + i, `p${20 + i}`, "pending"),
    ),
    ...[50, 51, 52, 53, 54, 55].map((i) => mk(i, `b${i}`, "pending", [999])),
   ],
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const out = lines.join("\n");
  assert.match(out, /\+3 more running/);
  assert.match(out, /\+15 more ready/);
  assert.match(out, /\+4 more blocked/);
 });

 it("explicit budgets override defaults", () => {
  const state: TaskState = {
   tasks: Array.from({ length: 6 }, (_, i) =>
    mk(20 + i, `p${20 + i}`, "pending"),
   ),
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
   budgets: { ready: 5 },
  });
  const out = lines.join("\n");
  assert.match(out, /\+1 more ready/);
 });
});

// ── B. Empty state preservation ────────────────────────────────────────

describe("overview-format: empty states", () => {
 it("fully empty (no active + no visible completed) → []", () => {
  const state: TaskState = { tasks: [], nextId: 1 };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  assert.deepEqual(lines, []);
 });

 it("archived-only (0 active + 0 visible completed + archived present) → []", () => {
  // B4 invariant: archived completed is NOT in completedVisible, so
  // completedVisible=0 + active=0 → truly empty. Caller (renderDefault)
  // decides the user-visible "No todos." wording.
  const state: TaskState = {
   tasks: [mk(1, "old", "completed", undefined)],
   nextId: 100,
  };
  // Add archivedAt manually (mk doesn't expose it; use literal).
  (state.tasks[0] as Task & { archivedAt?: number }).archivedAt = 100;
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  assert.deepEqual(lines, []);
 });
});

// ── C. Completed-only oracle equality with frozen formatTodosSnapshot ──

describe("overview-format: completed-only oracle", () => {
 it("active=0 + completedVisible>0 → exact frozen formatter output", () => {
  const state: TaskState = {
   tasks: [
    mk(1, "done a", "completed"),
    mk(2, "done b", "completed"),
    mk(3, "done c", "completed"),
   ],
   nextId: 100,
  };
  const view = viewFrom(state);
  const bounded = formatBoundedOverview(view, {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const frozen = formatTodosSnapshot(view, {
   width: 80,
  });
  assert.deepEqual(bounded, frozen);
 });

 it("active=0 + 1 visible completed → single ✓ summary line", () => {
  const state: TaskState = {
   tasks: [mk(1, "done a", "completed")],
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^✓ 1 completed · \/todos completed$/);
 });
});

// ── D. Default-budget semantics (omitted vs {} both → 2/3/2) ───────────

describe("overview-format: default-budget semantics", () => {
 it("budgets omitted → defaults 2/3/2 (matches {} behavior)", () => {
  const state: TaskState = {
   tasks: [
    ...[1, 2, 3, 4].map((i) => mk(i, `r${i}`, "in_progress")),
    ...Array.from({ length: 5 }, (_, i) => mk(20 + i, `p${20 + i}`, "pending")),
    ...[50, 51, 52, 53].map((i) => mk(i, `b${i}`, "pending", [999])),
   ],
   nextId: 100,
  };
  const omitted = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const empty = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
   budgets: {},
  });
  assert.deepEqual(omitted, empty);
  // 4 running → 2 + "+2 more running"
  assert.match(omitted.join("\n"), /\+2 more running/);
  // 5 ready → 3 + "+2 more ready"
  assert.match(omitted.join("\n"), /\+2 more ready/);
  // 4 blocked → 2 + "+2 more blocked"
  assert.match(omitted.join("\n"), /\+2 more blocked/);
 });

 it("budgets with one override leaves the other two at defaults", () => {
  const state: TaskState = {
   tasks: [
    ...[1, 2, 3, 4].map((i) => mk(i, `r${i}`, "in_progress")),
    ...Array.from({ length: 5 }, (_, i) => mk(20 + i, `p${20 + i}`, "pending")),
    ...[50, 51, 52, 53].map((i) => mk(i, `b${i}`, "pending", [999])),
   ],
   nextId: 100,
  };
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
   budgets: { running: 1 },
  });
  const out = lines.join("\n");
  // running overridden to 1 → 1 + "+3 more running"
  assert.match(out, /\+3 more running/);
  // ready at default 3 → 3 + "+2 more ready"
  assert.match(out, /\+2 more ready/);
  // blocked at default 2 → 2 + "+2 more blocked"
  assert.match(out, /\+2 more blocked/);
 });
});

// ── E. ARCHIVED never in bounded overview ──────────────────────────────

describe("overview-format: B4 invariant", () => {
 it("archived tasks never appear in bounded overview", () => {
  const state: TaskState = {
   tasks: [
    mk(1, "archived", "completed", undefined),
    mk(2, "active", "pending"),
   ],
   nextId: 100,
  };
  (state.tasks[0] as Task & { archivedAt?: number }).archivedAt = 100;
  const lines = formatBoundedOverview(viewFrom(state), {
   width: 80,
   dependencies: EMPTY_DEPS,
  });
  const out = lines.join("\n");
  assert.doesNotMatch(out, /#1/);
  assert.match(out, /◆ #2/);
  assert.doesNotMatch(out, /archived/);
 });
});
