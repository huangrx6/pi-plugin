/**
 * Unit tests for graph.ts — pure task-graph semantics.
 *
 * Every test is a hand-rolled TaskState fixture + a single
 * graph.ts call. No pi runtime, no store, no overlay. The
 * fixtures use minimal tasks (id, subject, status, blockedBy)
 * because graph.ts only reads those four fields.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  affectedByCompletion,
  brokenDependencies,
  dependenciesSatisfied,
  directDependencies,
  reverseDependencies,
  unsatisfiedDependencies,
  whyBlocked,
  wouldCreateCycle,
} from "./graph.ts";
import { normalizeTask } from "./types.ts";
import type { Task, TaskState } from "./types.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function mkTask(overrides: Partial<Task> & { id: number }): Task {
  return normalizeTask({
    subject: `task ${overrides.id}`,
    status: "pending",
    ...overrides,
  });
}

function mkState(...tasks: Task[]): TaskState {
  return { tasks: [...tasks], nextId: 1000 };
}

// ── directDependencies ──────────────────────────────────────────────────

describe("directDependencies", () => {
  it("returns [] when task has no blockedBy", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(directDependencies(state, 17), []);
  });

  it("returns existing deps in insertion order", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.deepEqual(
      directDependencies(state, 18).map((t) => t.id),
      [17],
    );
  });

  it("returns multiple deps preserving insertion order", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 19 }),
      mkTask({ id: 18, blockedBy: [17, 19] }),
    );
    assert.deepEqual(
      directDependencies(state, 18).map((t) => t.id),
      [17, 19],
    );
  });

  it("excludes missing ids (broken, surfaced via brokenDependencies)", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 18, blockedBy: [17, 999] }),
    );
    assert.deepEqual(
      directDependencies(state, 18).map((t) => t.id),
      [17],
    );
  });

  it("includes deleted tombstones (status-agnostic at this layer)", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.deepEqual(
      directDependencies(state, 18).map((t) => t.id),
      [17],
    );
  });

  it("returns [] for non-existent taskId", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(directDependencies(state, 999), []);
  });
});

// ── reverseDependencies ─────────────────────────────────────────────────

describe("reverseDependencies", () => {
  it("returns [] when nothing references taskId", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(reverseDependencies(state, 17), []);
  });

  it("returns referencing tasks in insertion order", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 18, blockedBy: [17] }),
      mkTask({ id: 19, blockedBy: [17] }),
    );
    assert.deepEqual(
      reverseDependencies(state, 17).map((t) => t.id),
      [18, 19],
    );
  });

  it("includes deleted tombstones (lineage preserved)", () => {
    const state = mkState(
      mkTask({ id: 17 }),
      mkTask({ id: 18, blockedBy: [17] }),
      mkTask({ id: 19, status: "deleted", blockedBy: [17] }),
    );
    assert.deepEqual(
      reverseDependencies(state, 17).map((t) => t.id),
      [18, 19],
    );
  });

  it("★ returns referencing tasks even when target id does not exist", () => {
    const state = mkState(mkTask({ id: 18, blockedBy: [99] }));
    assert.deepEqual(
      reverseDependencies(state, 99).map((t) => t.id),
      [18],
    );
  });
});

// ── brokenDependencies ──────────────────────────────────────────────────

describe("brokenDependencies", () => {
  it("returns [] when no blockedBy", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(brokenDependencies(state, 17), []);
  });

  it("returns missing ids with reason:missing", () => {
    const state = mkState(mkTask({ id: 18, blockedBy: [99] }));
    assert.deepEqual(brokenDependencies(state, 18), [
      { id: 99, reason: "missing" },
    ]);
  });

  it("returns deleted ids with reason:deleted", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.deepEqual(brokenDependencies(state, 18), [
      { id: 17, reason: "deleted" },
    ]);
  });

  it("returns mixed broken refs preserving insertion order", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, blockedBy: [17, 99] }),
    );
    assert.deepEqual(brokenDependencies(state, 18), [
      { id: 17, reason: "deleted" },
      { id: 99, reason: "missing" },
    ]);
  });

  it("ignores pending/in_progress refs (valid graph nodes)", () => {
    const state = mkState(
      mkTask({ id: 17, status: "pending" }),
      mkTask({ id: 19, status: "in_progress" }),
      mkTask({ id: 18, blockedBy: [17, 19] }),
    );
    assert.deepEqual(brokenDependencies(state, 18), []);
  });
});

// ── unsatisfiedDependencies ─────────────────────────────────────────────

describe("unsatisfiedDependencies", () => {
  it("returns [] when no blockedBy", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(unsatisfiedDependencies(state, 17), []);
  });

  it("returns pending and in_progress deps", () => {
    const state = mkState(
      mkTask({ id: 17, status: "pending" }),
      mkTask({ id: 19, status: "in_progress" }),
      mkTask({ id: 18, blockedBy: [17, 19] }),
    );
    assert.deepEqual(
      unsatisfiedDependencies(state, 18).map((t) => t.id),
      [17, 19],
    );
  });

  it("excludes completed deps", () => {
    const state = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.deepEqual(unsatisfiedDependencies(state, 18), []);
  });

  it("★ excludes deleted deps (partition: deleted is broken, not unsatisfied)", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.deepEqual(unsatisfiedDependencies(state, 18), []);
  });

  it("excludes missing deps (broken only)", () => {
    const state = mkState(mkTask({ id: 18, blockedBy: [99] }));
    assert.deepEqual(unsatisfiedDependencies(state, 18), []);
  });
});

// ── dependenciesSatisfied ───────────────────────────────────────────────

describe("dependenciesSatisfied", () => {
  it("returns true for task with no blockedBy (vacuous)", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.equal(dependenciesSatisfied(state, 17), true);
  });

  it("returns true when all deps are completed", () => {
    const state = mkState(
      mkTask({ id: 17, status: "completed" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.equal(dependenciesSatisfied(state, 18), true);
  });

  it("returns false when a dep is pending", () => {
    const state = mkState(
      mkTask({ id: 17, status: "pending" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.equal(dependenciesSatisfied(state, 18), false);
  });

  it("returns false when a dep is in_progress", () => {
    const state = mkState(
      mkTask({ id: 17, status: "in_progress" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.equal(dependenciesSatisfied(state, 18), false);
  });

  it("returns false when a dep is missing", () => {
    const state = mkState(mkTask({ id: 18, blockedBy: [99] }));
    assert.equal(dependenciesSatisfied(state, 18), false);
  });

  it("returns false when a dep is deleted", () => {
    const state = mkState(
      mkTask({ id: 17, status: "deleted" }),
      mkTask({ id: 18, blockedBy: [17] }),
    );
    assert.equal(dependenciesSatisfied(state, 18), false);
  });

  it("returns false for non-existent taskId (defensive)", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.equal(dependenciesSatisfied(state, 999), false);
  });
});

// ── wouldCreateCycle ────────────────────────────────────────────────────

describe("wouldCreateCycle", () => {
  it("detects self-loop (depId === taskId)", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.equal(wouldCreateCycle(state, 17, [17]), true);
  });

  it("detects direct 2-node cycle", () => {
    const state = mkState(mkTask({ id: 20, blockedBy: [19] }));
    assert.equal(wouldCreateCycle(state, 19, [20]), true);
  });

  it("returns false for safe edge (no existing path)", () => {
    const state = mkState(mkTask({ id: 20, blockedBy: [19] }));
    assert.equal(wouldCreateCycle(state, 20, [18]), false);
  });

  it("returns false for new taskId (no incoming edges possible)", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.equal(wouldCreateCycle(state, 999, [17]), false);
  });

  it("★ CORRECTED long-chain: 21→20→19, add 21→19 = no cycle", () => {
    const state = mkState(
      mkTask({ id: 20, blockedBy: [19] }),
      mkTask({ id: 21, blockedBy: [20] }),
    );
    assert.equal(wouldCreateCycle(state, 21, [19]), false);
  });

  it("★ CORRECTED long-chain: 21→20→19, add 19→21 = cycle", () => {
    const state = mkState(
      mkTask({ id: 20, blockedBy: [19] }),
      mkTask({ id: 21, blockedBy: [20] }),
    );
    assert.equal(wouldCreateCycle(state, 19, [21]), true);
  });

  it("★ detects cycle closing through dangling edge", () => {
    // #20 blockedBy [999], 999 not in state. Adding 999→20 closes 999→20→999.
    const state = mkState(mkTask({ id: 20, blockedBy: [999] }));
    assert.equal(wouldCreateCycle(state, 999, [20]), true);
  });

  it("returns false for empty nextBlockedBy", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.equal(wouldCreateCycle(state, 17, []), false);
  });

  it("any cycle-creator in multi-dep triggers true", () => {
    const state = mkState(
      mkTask({ id: 19 }),
      mkTask({ id: 20, blockedBy: [19] }),
    );
    // Adding 18→[17, 20]: 17 doesn't reach 18; 20→19 doesn't reach 18.
    assert.equal(wouldCreateCycle(state, 18, [17, 20]), false);
    // But 18→[19, 17]: 19→...→18? No. OK.
    assert.equal(wouldCreateCycle(state, 18, [19, 17]), false);
  });
});

// ── whyBlocked ──────────────────────────────────────────────────────────

describe("whyBlocked", () => {
  it("returns empty triple for unblocked task", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(whyBlocked(state, 17), {
      direct: [],
      roots: [],
      broken: [],
    });
  });

  it("★ Case A: linear chain, leaf root", () => {
    // #1 pending (no deps) → #2 → #3
    const state = mkState(
      mkTask({ id: 1 }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [2] }),
    );
    const r = whyBlocked(state, 3);
    assert.deepEqual(
      r.direct.map((t) => t.id),
      [2],
    );
    assert.deepEqual(
      r.roots.map((t) => t.id),
      [1],
    );
    assert.deepEqual(r.broken, []);
  });

  it("★ Case B: running root", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [2] }),
    );
    const r = whyBlocked(state, 3);
    assert.deepEqual(
      r.direct.map((t) => t.id),
      [2],
    );
    assert.deepEqual(
      r.roots.map((t) => t.id),
      [1],
    );
    assert.deepEqual(r.broken, []);
  });

  it("★ Case C: broken dep on closure root", () => {
    // #1 has broken [99]; #2 blockedBy [1]; broken on closure root.
    const state = mkState(
      mkTask({ id: 1, blockedBy: [99] }),
      mkTask({ id: 2, blockedBy: [1] }),
    );
    const r = whyBlocked(state, 2);
    assert.deepEqual(
      r.direct.map((t) => t.id),
      [1],
    );
    assert.deepEqual(
      r.roots.map((t) => t.id),
      [1],
    );
    assert.deepEqual(r.broken, [
      { taskId: 1, dependencyId: 99, reason: "missing" },
    ]);
  });

  it("★ Case D: multiple direct roots", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, status: "in_progress" }),
      mkTask({ id: 3, blockedBy: [1, 2] }),
    );
    const r = whyBlocked(state, 3);
    assert.deepEqual(r.direct.map((t) => t.id).sort(), [1, 2]);
    assert.deepEqual(r.roots.map((t) => t.id).sort(), [1, 2]);
    assert.deepEqual(r.broken, []);
  });

  it("★ Case E: task has only broken deps (no unsatisfied)", () => {
    const state = mkState(mkTask({ id: 17, blockedBy: [99] }));
    const r = whyBlocked(state, 17);
    assert.deepEqual(r.direct, []);
    assert.deepEqual(r.roots, []);
    assert.deepEqual(r.broken, [
      { taskId: 17, dependencyId: 99, reason: "missing" },
    ]);
  });

  it("★ Case F: broken at multiple chain levels", () => {
    const state = mkState(
      mkTask({ id: 1, blockedBy: [99] }),
      mkTask({ id: 2, blockedBy: [1, 88] }),
      mkTask({ id: 3, blockedBy: [2] }),
    );
    const r = whyBlocked(state, 3);
    assert.deepEqual(
      r.direct.map((t) => t.id),
      [2],
    );
    assert.deepEqual(
      r.roots.map((t) => t.id),
      [1],
    );
    // Closure order: BFS visits 3 → 2 → 1; flatMap iterates closure in that
    // order, so broken entries come out as B→88 then A→99.
    assert.deepEqual(r.broken, [
      { taskId: 2, dependencyId: 88, reason: "missing" },
      { taskId: 1, dependencyId: 99, reason: "missing" },
    ]);
  });

  it("★ Case G — GENUINE middle-node broken: A clean, B has missing", () => {
    // D → C → B(blockedBy[A, 99 missing]) → A(clean)
    // The broken dep is on B, which is in the middle of the closure,
    // not on the root. This proves blockerClosure is actually used.
    const state = mkState(
      mkTask({ id: 1 }), // A: clean root
      mkTask({ id: 2, blockedBy: [1, 99] }), // B: middle, missing 99
      mkTask({ id: 3, blockedBy: [2] }), // C
      mkTask({ id: 4, blockedBy: [3] }), // D (queried)
    );
    const r = whyBlocked(state, 4);
    assert.deepEqual(
      r.direct.map((t) => t.id),
      [3],
    );
    assert.deepEqual(
      r.roots.map((t) => t.id),
      [1],
    );
    assert.deepEqual(r.broken, [
      { taskId: 2, dependencyId: 99, reason: "missing" },
    ]);
  });

  it("★ Case H: legacy cycle terminates; roots may be empty", () => {
    // #1 ↔ #2 (cyclic pending); #3 blockedBy [1].
    // BFS must terminate; no root reachable from the cyclic component.
    const state = mkState(
      mkTask({ id: 1, blockedBy: [2] }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [1] }),
    );
    const r = whyBlocked(state, 3);
    assert.deepEqual(
      r.direct.map((t) => t.id),
      [1],
    );
    assert.deepEqual(r.roots, []); // cyclic component has no root
    assert.deepEqual(r.broken, []);
  });

  it("returns empty triple for non-existent taskId", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(whyBlocked(state, 999), {
      direct: [],
      roots: [],
      broken: [],
    });
  });
});

// ── affectedByCompletion ────────────────────────────────────────────────

describe("affectedByCompletion", () => {
  it("★ Case A: leaf completion unlocks one downstream", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [2] }),
    );
    const r = affectedByCompletion(state, 1);
    assert.deepEqual(
      r.newlySatisfied.map((t) => t.id),
      [2],
    );
    assert.deepEqual(
      r.downstream.map((t) => t.id),
      [2, 3],
    );
  });

  it("★ Case B: fan-out unlock", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [1] }),
    );
    const r = affectedByCompletion(state, 1);
    assert.deepEqual(r.newlySatisfied.map((t) => t.id).sort(), [2, 3]);
    assert.deepEqual(r.downstream.map((t) => t.id).sort(), [2, 3]);
  });

  it("★ Case C: partial unlock (other dep still pending)", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [1, 4] }),
      mkTask({ id: 4, blockedBy: [2] }),
    );
    const r = affectedByCompletion(state, 1);
    assert.deepEqual(
      r.newlySatisfied.map((t) => t.id),
      [2],
    );
    assert.deepEqual(r.downstream.map((t) => t.id).sort(), [2, 3, 4]);
  });

  it("★ Case D: already completed task → empty", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed" }),
      mkTask({ id: 2, blockedBy: [1] }),
    );
    assert.deepEqual(affectedByCompletion(state, 1), {
      newlySatisfied: [],
      downstream: [],
    });
  });

  it("★ Case E: deleted task → empty", () => {
    const state = mkState(
      mkTask({ id: 1, status: "deleted" }),
      mkTask({ id: 2, blockedBy: [1] }),
    );
    assert.deepEqual(affectedByCompletion(state, 1), {
      newlySatisfied: [],
      downstream: [],
    });
  });

  it("★ Case F: downstream cuts off at deleted (graph dead end)", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, status: "deleted", blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [2] }),
    );
    const r = affectedByCompletion(state, 1);
    assert.deepEqual(r, { newlySatisfied: [], downstream: [] });
  });

  it("★ Case G: diamond for count display", () => {
    const state = mkState(
      mkTask({ id: 1, status: "in_progress" }),
      mkTask({ id: 2, blockedBy: [1] }),
      mkTask({ id: 3, blockedBy: [1] }),
      mkTask({ id: 4, blockedBy: [2, 3] }),
    );
    const r = affectedByCompletion(state, 1);
    assert.deepEqual(r.newlySatisfied.map((t) => t.id).sort(), [2, 3]);
    assert.deepEqual(r.downstream.map((t) => t.id).sort(), [2, 3, 4]);
  });

  it("★ allows hypothetical completion on pending task (graph query)", () => {
    const state = mkState(
      mkTask({ id: 1, status: "pending" }),
      mkTask({ id: 2, blockedBy: [1] }),
    );
    const r = affectedByCompletion(state, 1);
    assert.deepEqual(
      r.newlySatisfied.map((t) => t.id),
      [2],
    );
  });

  it("returns empty for non-existent taskId", () => {
    const state = mkState(mkTask({ id: 17 }));
    assert.deepEqual(affectedByCompletion(state, 999), {
      newlySatisfied: [],
      downstream: [],
    });
  });
});

// ── Module invariant: graph.ts never references projection concepts ──────

describe("graph.ts layer purity", () => {
  it("does not reference READY/BLOCKED/RUNNING/visible/overlay/section in code", async () => {
    // Test always runs from the pi-todo package root (npm test cwd).
    const src = await readFile("graph.ts", "utf8");
    // Strip comments so doc text can mention these tokens if needed.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const forbidden = [
      "READY",
      "BLOCKED",
      "RUNNING",
      "visible",
      "overlay",
      "section",
    ];
    for (const tok of forbidden) {
      assert.ok(
        !code.includes(tok),
        `graph.ts contains forbidden projection-layer token "${tok}"`,
      );
    }
  });
});
