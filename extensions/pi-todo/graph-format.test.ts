/**
 * Unit tests for graph-format.ts (P2-B presentation).
 *
 * Critical invariants tested (P2-B LOCK):
 *   1. P2-B only consumes P2-A results + width (no TaskState).
 *   2. Indented rows use width - INDENT, not width - header.
 *   3. Task role glyphs come from frozen formatTaskRow.
 *   4. Blocker rows: ○ via frozen formatTaskRow, markers via
 *      TaskDependencyPresentation.kind only.
 *   5. result.kind → section structure / wording.
 *      task.role  → canonical row presentation.
 *   6. No `.status` / `.archivedAt` / `.filter(` / `.sort(` / `query*
 *    in code.
 *   7. type-only import from graph-query.ts.
 *
 *   Tests construct P2-A result objects directly (no query layer).
 *   22 behavior + 4 architecture = 26 tests.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
 formatNextTasks,
 formatUnlocksTask,
 formatWhyTask,
} from "./graph-format.ts";
import type {
 NextTasksResult,
 TaskPresentation,
 TaskPresentationRole,
 UnlocksTaskResult,
 WhyTaskResult,
} from "./graph-query.ts";
import type { TaskDependencyPresentation } from "./types.ts";

const WIDTH = 80;

// ── Fixtures ──────────────────────────────────────────────────────────

function pres(
 id: number,
 role: TaskPresentationRole,
 subject = `task ${id}`,
): TaskPresentation {
 return { id, subject, role };
}

// ── A. formatNextTasks (4 tests) ───────────────────────────────────────

describe("formatNextTasks", () => {
 it("★ 1 empty → ['No tasks are ready.']", () => {
  const result: NextTasksResult = { kind: "next", tasks: [] };
  assert.deepEqual(formatNextTasks(result, WIDTH), ["No tasks are ready."]);
 });

 it("★ 2 one READY → ['Next:', '  ◆ #18 ...']", () => {
  const result: NextTasksResult = {
   kind: "next",
   tasks: [pres(18, "ready", "Write integration tests")],
  };
  const lines = formatNextTasks(result, WIDTH);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "Next:");
  assert.match(lines[1]!, /^ {2}◆ #18/);
 });

 it("★ 3 multiple READY → order preserved", () => {
  const result: NextTasksResult = {
   kind: "next",
   tasks: [
    pres(18, "ready", "alpha"),
    pres(21, "ready", "beta"),
    pres(7, "ready", "gamma"),
   ],
  };
  const lines = formatNextTasks(result, WIDTH);
  assert.equal(lines[0], "Next:");
  // Extract id from each row.
  const ids = lines.slice(1).map((l) => l.match(/#(\d+)/)?.[1]);
  assert.deepEqual(ids, ["18", "21", "7"]);
 });

 it("★ 4 width passed through → narrow width truncates subject", () => {
  const result: NextTasksResult = {
   kind: "next",
   tasks: [pres(18, "ready", "a".repeat(50))],
  };
  // Narrow width: 8 total minus 2 indent = 6 for the row.
  const lines = formatNextTasks(result, 8);
  assert.equal(lines[0], "Next:");
  // Row truncated by formatTaskRow.
  assert.ok(
   lines[1]!.length <= 8,
   `row length ${lines[1]!.length} must fit width 8`,
  );
  assert.match(lines[1]!, /^ {2}◆ #18/);
 });
});

// ── B. formatWhyTask (9 tests) ──────────────────────────────────────────

describe("formatWhyTask", () => {
 it("★ 5 not-found → ['Task #18 not found.']", () => {
  const result: WhyTaskResult = { kind: "not-found", id: 18 };
  assert.deepEqual(formatWhyTask(result, WIDTH), ["Task #18 not found."]);
 });

 it("★ 6 ready → [row, 'Ready to start.']", () => {
  const result: WhyTaskResult = {
   kind: "ready",
   task: pres(18, "ready"),
  };
  const lines = formatWhyTask(result, WIDTH);
  assert.match(lines[0]!, /^◆ #18/);
  assert.equal(lines[1], "Ready to start.");
 });

 it("★ 7 running → [row, 'Already running.']", () => {
  const result: WhyTaskResult = {
   kind: "running",
   task: pres(18, "running"),
  };
  const lines = formatWhyTask(result, WIDTH);
  assert.match(lines[0]!, /^▶ #18/);
  assert.equal(lines[1], "Already running.");
 });

 it("★ 8 completed → [row, 'Completed.']", () => {
  const result: WhyTaskResult = {
   kind: "completed",
   task: pres(18, "completed"),
  };
  const lines = formatWhyTask(result, WIDTH);
  assert.match(lines[0]!, /^✓ #18/);
  assert.equal(lines[1], "Completed.");
 });

 it("★ 9 archived → [row, 'Archived.']", () => {
  const result: WhyTaskResult = {
   kind: "archived",
   task: pres(18, "archived"),
  };
  const lines = formatWhyTask(result, WIDTH);
  // archivedAt isn't in TaskPresentation; formatTaskRow handles archived
  // via role.
  assert.match(lines[0]!, /^· #18/);
  assert.equal(lines[1], "Archived.");
 });

 it("★ 10 blocked single blocker → [row, '', 'Blocked by:', '  ○ #13']", () => {
  const blocking: TaskDependencyPresentation[] = [{ id: 13, kind: "waiting" }];
  const result: WhyTaskResult = {
   kind: "blocked",
   task: pres(18, "blocked"),
   blocking,
  };
  const lines = formatWhyTask(result, WIDTH);
  assert.match(lines[0]!, /^○ #18/);
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Blocked by:");
  assert.match(lines[3]!, /^ {2}○ #13$/);
 });

 it("★ 11 blocked multiple blockers → order preserved", () => {
  const blocking: TaskDependencyPresentation[] = [
   { id: 13, kind: "waiting" },
   { id: 99, kind: "missing" },
   { id: 7, kind: "waiting" },
  ];
  const result: WhyTaskResult = {
   kind: "blocked",
   task: pres(18, "blocked"),
   blocking,
  };
  const lines = formatWhyTask(result, WIDTH);
  const idx = lines.indexOf("Blocked by:");
  assert.notEqual(idx, -1);
  const after = lines.slice(idx + 1);
  assert.equal(after.length, 3);
  // IDs in canonical presentation order (waiting / missing / waiting).
  assert.match(after[0]!, /○ #13$/);
  assert.match(after[1]!, /○ #99\?$/);
  assert.match(after[2]!, /○ #7$/);
 });

 it("★ 12 broken dep missing → '○ #99?'", () => {
  const blocking: TaskDependencyPresentation[] = [{ id: 99, kind: "missing" }];
  const result: WhyTaskResult = {
   kind: "blocked",
   task: pres(18, "blocked"),
   blocking,
  };
  const lines = formatWhyTask(result, WIDTH);
  const idx = lines.indexOf("Blocked by:");
  assert.match(lines[idx + 1]!, /○ #99\?$/);
 });

 it("★ 13 broken dep deleted → '○ #17†'", () => {
  const blocking: TaskDependencyPresentation[] = [{ id: 17, kind: "deleted" }];
  const result: WhyTaskResult = {
   kind: "blocked",
   task: pres(18, "blocked"),
   blocking,
  };
  const lines = formatWhyTask(result, WIDTH);
  const idx = lines.indexOf("Blocked by:");
  assert.match(lines[idx + 1]!, /○ #17†$/);
 });
});

// ── C. formatUnlocksTask (9 tests) ────────────────────────────────────

describe("formatUnlocksTask", () => {
 it("★ 14 not-found → ['Task #12 not found.']", () => {
  const result: UnlocksTaskResult = { kind: "not-found", id: 12 };
  assert.deepEqual(formatUnlocksTask(result, WIDTH), ["Task #12 not found."]);
 });

 it("★ 15 completed → [row, 'Already completed.']", () => {
  const result: UnlocksTaskResult = {
   kind: "completed",
   task: pres(12, "completed"),
  };
  const lines = formatUnlocksTask(result, WIDTH);
  assert.match(lines[0]!, /^✓ #12/);
  assert.equal(lines[1], "Already completed.");
 });

 it("★ 16 archived → [row, 'Archived.']", () => {
  const result: UnlocksTaskResult = {
   kind: "archived",
   task: pres(12, "archived"),
  };
  const lines = formatUnlocksTask(result, WIDTH);
  assert.match(lines[0]!, /^· #12/);
  assert.equal(lines[1], "Archived.");
 });

 it("★ 17 READY current + one unlock → [head, '', header, row]", () => {
  const result: UnlocksTaskResult = {
   kind: "unlocks",
   task: pres(12, "ready"),
   unlocks: [pres(18, "ready")],
  };
  const lines = formatUnlocksTask(result, WIDTH);
  assert.match(lines[0]!, /^◆ #12/);
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Completing this task would make ready:");
  assert.match(lines[3]!, /^ {2}◆ #18/);
 });

 it("★ 18 RUNNING current → head row is ▶", () => {
  const result: UnlocksTaskResult = {
   kind: "unlocks",
   task: pres(12, "running"),
   unlocks: [],
  };
  const lines = formatUnlocksTask(result, WIDTH);
  assert.match(lines[0]!, /^▶ #12/);
 });

 it("★ 19 BLOCKED current → head row is ○ (NOT ready icon)", () => {
  const result: UnlocksTaskResult = {
   kind: "unlocks",
   task: pres(12, "blocked"),
   unlocks: [pres(18, "ready")],
  };
  const lines = formatUnlocksTask(result, WIDTH);
  // task.role is "blocked", so head row uses ○.
  assert.match(lines[0]!, /^○ #12/);
  // But unlocks children remain role="ready" (P2-A already decided).
  const idx = lines.indexOf("Completing this task would make ready:");
  assert.match(lines[idx + 1]!, /^ {2}◆ #18/);
 });

 it("★ 20 multiple unlocks → order preserved", () => {
  const result: UnlocksTaskResult = {
   kind: "unlocks",
   task: pres(12, "ready"),
   unlocks: [
    pres(18, "ready", "alpha"),
    pres(21, "ready", "beta"),
    pres(7, "ready", "gamma"),
   ],
  };
  const lines = formatUnlocksTask(result, WIDTH);
  const idx = lines.indexOf("Completing this task would make ready:");
  const ids = lines.slice(idx + 1).map((l) => l.match(/#(\d+)/)?.[1]);
  assert.deepEqual(ids, ["18", "21", "7"]);
 });

 it("★ 21 empty unlocks → head + '' + 'directly' message", () => {
  const result: UnlocksTaskResult = {
   kind: "unlocks",
   task: pres(12, "ready"),
   unlocks: [],
  };
  const lines = formatUnlocksTask(result, WIDTH);
  assert.match(lines[0]!, /^◆ #12/);
  assert.equal(lines[1], "");
  assert.equal(
   lines[2],
   "Completing this task would not directly unlock any tasks.",
  );
  assert.equal(lines.length, 3);
 });

 it("★ 22 unlocks role='ready' even when current BLOCKED (no re-validation)", () => {
  // P2-A already pinned unlocks[*].role = "ready" (LOCK §10).
  // P2-B does not re-derive role from current task state.
  const result: UnlocksTaskResult = {
   kind: "unlocks",
   task: pres(12, "blocked"),
   unlocks: [pres(18, "ready", "writer"), pres(21, "ready", "tests")],
  };
  const lines = formatUnlocksTask(result, WIDTH);
  const idx = lines.indexOf("Completing this task would make ready:");
  assert.match(lines[idx + 1]!, /^ {2}◆ #18/);
  assert.match(lines[idx + 2]!, /^ {2}◆ #21/);
 });
});

// ── D. Architecture (4 tests) ──────────────────────────────────────────

describe("graph-format: architecture", () => {
 it("★ 23 forbidden imports empty (LOCK §2)", async () => {
  const src = await readFile("graph-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Boundary-aware regex: matches `from "./<module>"` or `from "./<module>/..."`
  // but NOT `from "./<module>-foo..."` (so "./graph" doesn't match
  // the allowed "./graph-query.ts").
  const forbidden = [
   "graph",
   "projection",
   "read-model",
   "reducer",
   "store",
   "index",
   "mutation-command",
   "mutation-selector",
   "mutation-executor",
   "mutation-outcome",
   "mutation-format",
   "mutation-wiring",
  ];
  for (const m of forbidden) {
   const re = new RegExp(`from\\s+["']\\.\\/${m}(?:["']|/)`);
   assert.ok(
    !re.test(code),
    `graph-format.ts contains forbidden module import "${m}"`,
   );
  }
 });

 it("★ 24 no .status / .archivedAt in code (LOCK §5)", async () => {
  const src = await readFile("graph-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
   !/\.(status|archivedAt)\b/.test(code),
   "graph-format.ts must not read .status or .archivedAt",
  );
 });

 it("★ 25 no .filter( / .sort( / query* strings (LOCK §9, §4)", async () => {
  const src = await readFile("graph-format.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/\.filter\(/.test(code), "graph-format.ts must not call .filter(");
  assert.ok(!/\.sort\(/.test(code), "graph-format.ts must not call .sort(");
  assert.ok(
   !/query(NextTasks|WhyTask|UnlocksTask)/.test(code),
   "graph-format.ts must not call any P2-A query function",
  );
 });

 it("★ 26 type-only import from graph-query.ts (LOCK §3)", async () => {
  const src = await readFile("graph-format.ts", "utf8");
  // Type-only import lines from graph-query must exist.
  assert.ok(
   /import\s+type\s*\{[^}]+\}\s*from\s*"\.\/graph-query\.ts"/.test(src),
   "graph-format.ts must use `import type` for graph-query.ts",
  );
  // And no value (runtime) import from graph-query.
  assert.ok(
   !/import\s*\{\s*(queryNextTasks|queryWhyTask|queryUnlocksTask)[^}]*\}\s*from\s*"\.\/graph-query\.ts"/.test(
    src,
   ),
   "graph-format.ts must not runtime-import from graph-query.ts",
  );
 });
});
