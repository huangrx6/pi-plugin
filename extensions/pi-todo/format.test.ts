/**
 * Unit tests for format.ts B2 additions (P0-B / B2).
 *
 * Scope (LOCKED B2):
 *   - displayWidth / truncateToWidth (existing helpers, contract-naming)
 *   - ROLE_ICON mapping
 *   - formatTaskRow: 4-tier width degradation + subject priority
 *   - formatTaskDetail: aligned two-column layout + description/metadata
 *   - formatTodosSnapshot: grouped active view + ✓ N summary
 *   - layer purity: format.ts does not import graph/projection
 *
 * Out of scope (later P0-B phases or P1):
 *   - /todos command routing (B3)
 *   - overlay widget rewrite (B4)
 *   - mutation delta formatter (P1)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  displayWidth,
  formatTaskDetail,
  formatTaskRow,
  formatTodosSnapshot,
  truncateToWidth,
  visibleWidth,
} from "./format.ts";
import { projectActiveView } from "./projection.ts";
import { EMPTY_STATE, normalizeTask } from "./types.ts";
import type {
  Task,
  TaskDependencyPresentation,
  TaskDetailContext,
  TaskRowContext,
  TaskState,
  TodosSnapshotContext,
} from "./types.ts";

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

const rowCtx = (
  role: TaskRowContext["role"],
  width: number,
  dependencies?: readonly TaskDependencyPresentation[],
): TaskRowContext => ({
  role,
  width,
  ...(dependencies ? { dependencies } : {}),
});

const detailCtx = (
  width: number,
  extras: Partial<TaskDetailContext> = {},
): TaskDetailContext => ({ width, ...extras });

const snapCtx = (
  width: number,
  dependencies?: ReadonlyMap<number, readonly TaskDependencyPresentation[]>,
): TodosSnapshotContext => ({
  width,
  ...(dependencies ? { dependencies } : {}),
});

// ── displayWidth / truncateToWidth contract ─────────────────────────────

describe("displayWidth / truncateToWidth", () => {
  it("ASCII: 'hello' = 5", () => {
    assert.equal(displayWidth("hello"), 5);
  });

  it("CJK: '中文' = 4 (2 cells each)", () => {
    assert.equal(displayWidth("中文"), 4);
  });

  it("mixed: 'hi 中文' = 7", () => {
    assert.equal(displayWidth("hi 中文"), 2 + 1 + 4);
  });

  it("empty string = 0", () => {
    assert.equal(displayWidth(""), 0);
  });

  it("tab treated as 3 spaces (existing helper behavior)", () => {
    assert.equal(displayWidth("a\tb"), 1 + 3 + 1);
  });

  it("truncateToWidth: fits → unchanged", () => {
    assert.equal(truncateToWidth("abc", 10, "…"), "abc");
  });

  it("truncateToWidth: too long → suffix appended, content truncated", () => {
    const out = truncateToWidth("abcdefghij", 6, "…");
    // Existing truncateToWidth appends ANSI reset which makes .length
    // longer than input. We assert on visibleWidth + suffix presence.
    assert.ok(out.includes("…"));
    assert.ok(displayWidth(out.replace(/\x1b\[0m/g, "")) <= 6);
  });

  it("visibleWidth (existing helper) matches displayWidth on plain ASCII", () => {
    assert.equal(displayWidth("hello"), visibleWidth("hello"));
  });
});

// ── ROLE_ICON visual language ───────────────────────────────────────────

describe("ROLE_ICON mapping", () => {
  it("running → ▶", () => {
    const t = mkTask({ id: 17, status: "in_progress" });
    assert.equal(formatTaskRow(t, rowCtx("running", 80)).startsWith("▶"), true);
  });

  it("ready → ◆", () => {
    const t = mkTask({ id: 17, status: "pending" });
    assert.equal(formatTaskRow(t, rowCtx("ready", 80)).startsWith("◆"), true);
  });

  it("blocked → ○", () => {
    const t = mkTask({ id: 17, status: "pending", blockedBy: [1] });
    assert.equal(formatTaskRow(t, rowCtx("blocked", 80)).startsWith("○"), true);
  });

  it("completed → ✓", () => {
    const t = mkTask({ id: 17, status: "completed" });
    assert.equal(
      formatTaskRow(t, rowCtx("completed", 80)).startsWith("✓"),
      true,
    );
  });

  it("archived → · (mid-dot, not ✓ — archive is visibility not lifecycle)", () => {
    const t = mkTask({ id: 17, status: "completed", archivedAt: 100 });
    assert.equal(
      formatTaskRow(t, rowCtx("archived", 80)).startsWith("·"),
      true,
    );
  });
});

// ── formatTaskRow: tier degradation ──────────────────────────────────────

describe("formatTaskRow — tier 1 (full deps fit)", () => {
  it("subject + 1-2 deps fits → full form", () => {
    const t = mkTask({
      id: 18,
      subject: "Integration tests",
      blockedBy: [17],
    });
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 80, [{ id: 17, kind: "waiting" }]),
    );
    assert.match(out, /← #17/);
    assert.doesNotMatch(out, /\+\d/); // no +N
  });

  it("subject + 3 deps fits → all 3 deps shown (full form)", () => {
    const t = mkTask({
      id: 20,
      subject: "Update README",
      blockedBy: [18, 19, 21],
    });
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 80, [
        { id: 18, kind: "waiting" },
        { id: 19, kind: "waiting" },
        { id: 21, kind: "waiting" },
      ]),
    );
    assert.match(out, /← #18 #19 #21/);
  });
});

describe("formatTaskRow — tier 2 (compact deps)", () => {
  it("subject fits, full deps doesn't, compact does → compact form", () => {
    const t = mkTask({
      id: 20,
      subject: "Update README",
      blockedBy: [18, 19, 21, 22, 23],
    });
    // width 40: prefix ~5, subject ~12, full deps "← #18 #19 #21 #22 #23" ~24
    // → tier 1 fails; compact "← #18 #19 +3" ~14 → tier 2 fits
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 40, [
        { id: 18, kind: "waiting" },
        { id: 19, kind: "waiting" },
        { id: 21, kind: "waiting" },
        { id: 22, kind: "waiting" },
        { id: 23, kind: "waiting" },
      ]),
    );
    assert.match(out, /← #18 #19 \+3/);
  });
});

describe("formatTaskRow — tier 3 (no deps)", () => {
  it("subject fits, neither deps form does → no deps suffix", () => {
    const t = mkTask({
      id: 20,
      subject: "Update README",
      blockedBy: [18, 19, 21, 22, 23],
    });
    // width 22: prefix ~5, subject ~12, full deps 24 too long,
    // compact deps 14 too long → tier 3
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 22, [
        { id: 18, kind: "waiting" },
        { id: 19, kind: "waiting" },
        { id: 21, kind: "waiting" },
        { id: 22, kind: "waiting" },
        { id: 23, kind: "waiting" },
      ]),
    );
    assert.doesNotMatch(out, /←/);
    assert.match(out, /Update README/);
  });
});

describe("formatTaskRow — tier 4 (subject truncated)", () => {
  it("subject doesn't fit → subject truncated, deps dropped", () => {
    const t = mkTask({
      id: 20,
      subject: "abcdefghijklmnopqrstuvwxyz0123456789",
      blockedBy: [18],
    });
    // width 12: prefix 5, subjectSpace 6, subject way too long
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 12, [{ id: 18, kind: "waiting" }]),
    );
    assert.doesNotMatch(out, /←/); // deps dropped
    assert.ok(out.endsWith("…") || out.includes("…"));
  });
});

describe("formatTaskRow — subject priority (LOCKED B2 invariant)", () => {
  it("never truncates subject to keep '+N' (drops deps first)", () => {
    // Setup: 5 deps, narrow width. Subject fits but deps don't.
    // Expected: tier 3 (no deps), full subject preserved.
    const t = mkTask({
      id: 20,
      subject: "abcdefghij", // 10 chars
      blockedBy: [18, 19, 21, 22, 23],
    });
    // width 17: prefix 5, subjectSpace 11, subject 10 fits
    // full deps 26 too long, compact 14 too long → tier 3 (no deps)
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 17, [
        { id: 18, kind: "waiting" },
        { id: 19, kind: "waiting" },
        { id: 21, kind: "waiting" },
        { id: 22, kind: "waiting" },
        { id: 23, kind: "waiting" },
      ]),
    );
    assert.match(out, /abcdefghij/); // full subject kept
    assert.doesNotMatch(out, /←/); // deps dropped
    assert.ok(!out.endsWith("…")); // subject NOT truncated
  });
});

describe("formatTaskRow — dependency kind markers", () => {
  it("waiting dep renders as '#18'", () => {
    const t = mkTask({ id: 20, subject: "x", blockedBy: [18] });
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 80, [{ id: 18, kind: "waiting" }]),
    );
    assert.match(out, /← #18(?!\?|†)/);
  });

  it("missing dep renders as '#18?'", () => {
    const t = mkTask({ id: 20, subject: "x", blockedBy: [18] });
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 80, [{ id: 18, kind: "missing" }]),
    );
    assert.match(out, /← #18\?/);
  });

  it("deleted dep renders as '#18†'", () => {
    const t = mkTask({ id: 20, subject: "x", blockedBy: [18] });
    const out = formatTaskRow(
      t,
      rowCtx("blocked", 80, [{ id: 18, kind: "deleted" }]),
    );
    assert.match(out, /← #18†/);
  });
});

describe("formatTaskRow — edge cases", () => {
  it("no deps → no suffix", () => {
    const t = mkTask({ id: 17, subject: "parser" });
    const out = formatTaskRow(t, rowCtx("ready", 80));
    assert.doesNotMatch(out, /←/);
  });

  it("empty subject → just prefix, no duplicate id", () => {
    const t = mkTask({ id: 17, subject: "" });
    const out = formatTaskRow(t, rowCtx("ready", 80));
    // Role "ready" → ◆ icon; should be just "◆ #17" not "◆ #17  #17"
    assert.equal(out, "◆ #17");
  });

  it("width 0 → empty string", () => {
    const t = mkTask({ id: 17 });
    assert.equal(formatTaskRow(t, rowCtx("ready", 0)), "");
  });

  it("width smaller than prefix → truncated prefix", () => {
    const t = mkTask({ id: 17 });
    const out = formatTaskRow(t, rowCtx("ready", 3)); // prefix "▶ #17" needs 5
    assert.ok(displayWidth(out) <= 3);
  });
});

// ── formatTaskDetail ────────────────────────────────────────────────────

describe("formatTaskDetail", () => {
  it("full panel with all fields populated", () => {
    const t = mkTask({
      id: 17,
      subject: "Parser",
      status: "completed",
      description: "Long description text.",
      owner: "agent",
      createdAt: 1700000000000,
      updatedAt: 1700001000000,
      archivedAt: 1700002000000,
    });
    t.metadata = { priority: "high", count: 3 };
    const lines = formatTaskDetail(
      t,
      detailCtx(80, {
        role: "completed",
        dependencies: [{ id: 18, kind: "waiting" }],
        reverseDependencyIds: [20, 22],
      }),
    );
    assert.match(lines[0]!, /#17 {2}Parser/);
    assert.ok(lines.some((l) => /State\s+completed/.test(l)));
    assert.ok(lines.some((l) => /Status\s+completed/.test(l)));
    assert.ok(lines.some((l) => /Created\s+\d{4}-\d{2}-\d{2}/.test(l)));
    assert.ok(lines.some((l) => l.includes("Depends on")));
    assert.ok(lines.some((l) => l.includes("#18")));
    assert.ok(lines.some((l) => /Required by\s+#20 #22/.test(l)));
    assert.ok(lines.some((l) => l.includes("Description")));
    assert.ok(lines.some((l) => l.includes("Metadata")));
    assert.ok(lines.some((l) => l.includes("count: 3")));
    assert.ok(lines.some((l) => l.includes("priority: high")));
    // owner is on task.owner but is NOT rendered in current B2 detail layout
    // (user contract: no Owner line). Test would only check task.metadata fields.
  });

  it("empty task → minimal panel (subject + status)", () => {
    const t = mkTask({ id: 17, subject: "x", status: "pending" });
    const lines = formatTaskDetail(t, detailCtx(80));
    assert.ok(lines.some((l) => l.includes("#17  x")));
    assert.ok(lines.some((l) => /Status\s+pending/.test(l)));
    // No description, no metadata, no deps
    assert.ok(!lines.some((l) => l.includes("Description")));
    assert.ok(!lines.some((l) => l.includes("Metadata")));
    assert.ok(lines.some((l) => /Depends on\s+—/.test(l)));
    assert.ok(lines.some((l) => /Required by\s+—/.test(l)));
  });

  it("no role → State line hidden", () => {
    const t = mkTask({ id: 17, subject: "x", status: "completed" });
    const lines = formatTaskDetail(t, detailCtx(80));
    assert.ok(!lines.some((l) => l.startsWith("State")));
  });

  it("role provided → State line shown", () => {
    const t = mkTask({ id: 17, subject: "x", status: "pending" });
    const lines = formatTaskDetail(t, detailCtx(80, { role: "ready" }));
    assert.ok(lines.some((l) => /State\s+ready/.test(l)));
  });

  it("metadata keys sorted alphabetically", () => {
    const t = mkTask({ id: 17, subject: "x" });
    t.metadata = { zebra: "z", alpha: "a", mango: "m" };
    const lines = formatTaskDetail(t, detailCtx(80));
    const metaStart = lines.findIndex((l) => l === "Metadata");
    assert.ok(metaStart >= 0);
    assert.match(lines[metaStart + 1]!, /alpha:/);
    assert.match(lines[metaStart + 2]!, /mango:/);
    assert.match(lines[metaStart + 3]!, /zebra:/);
  });

  it("metadata value: object → compact JSON", () => {
    const t = mkTask({ id: 17, subject: "x" });
    t.metadata = { config: { timeout: 30, retries: 3 } };
    const lines = formatTaskDetail(t, detailCtx(80));
    assert.ok(lines.some((l) => l.includes('{"timeout":30,"retries":3}')));
  });

  it("metadata value: string with newlines → single-line sanitized", () => {
    const t = mkTask({ id: 17, subject: "x" });
    t.metadata = { note: "line1\nline2\r\nline3" };
    const lines = formatTaskDetail(t, detailCtx(80));
    const noteLine = lines.find((l) => l.startsWith("  note:"));
    assert.ok(noteLine);
    assert.ok(!noteLine!.includes("\n"));
    assert.match(noteLine!, /line1 line2 line3/);
  });

  it("metadata value: null / undefined → literal", () => {
    const t = mkTask({ id: 17, subject: "x" });
    t.metadata = { a: null, b: undefined };
    const lines = formatTaskDetail(t, detailCtx(80));
    assert.ok(lines.some((l) => l.includes("a: null")));
    assert.ok(lines.some((l) => l.includes("b: undefined")));
  });

  it("★ depends on missing dep → '#99?' (kind rendered)", () => {
    const t = mkTask({ id: 17, subject: "x" });
    const lines = formatTaskDetail(
      t,
      detailCtx(80, {
        dependencies: [
          { id: 18, kind: "waiting" },
          { id: 99, kind: "missing" },
        ],
      }),
    );
    assert.ok(lines.some((l) => l.includes("#18") && l.includes("#99?")));
  });
});

// ── formatTodosSnapshot ────────────────────────────────────────────────

describe("formatTodosSnapshot", () => {
  it("empty view, completedVisible = 0 → empty", () => {
    const view = projectActiveView(mkState());
    assert.deepEqual(formatTodosSnapshot(view, snapCtx(80)), []);
  });

  it("empty view, completedVisible > 0 → just ✓ line", () => {
    const state = mkState(mkTask({ id: 1, status: "completed" }));
    const view = projectActiveView(state);
    const lines = formatTodosSnapshot(view, snapCtx(80));
    assert.deepEqual(lines, ["✓ 1 completed · /todos completed"]);
  });

  it("running section", () => {
    const state = mkState(mkTask({ id: 17, status: "in_progress" }));
    const view = projectActiveView(state);
    const lines = formatTodosSnapshot(view, snapCtx(80));
    assert.equal(lines[0], "RUNNING");
    assert.match(lines[1]!, /▶ #17/);
  });

  it("ready + blocked + completed summary", () => {
    const state = mkState(
      mkTask({ id: 1, status: "completed" }),
      mkTask({ id: 17, status: "pending" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17] }),
    );
    const view = projectActiveView(state);
    const lines = formatTodosSnapshot(view, snapCtx(80));
    assert.ok(lines.some((l) => l === "READY"));
    assert.ok(lines.some((l) => l === "BLOCKED"));
    assert.ok(lines.some((l) => l === "✓ 1 completed · /todos completed"));
  });

  it("★ blocked rows use ctx.dependencies for kind markers", () => {
    // #18 blockedBy [17], but 17 is missing → kind: missing.
    const state = mkState(
      mkTask({ id: 17, status: "pending" }),
      mkTask({ id: 18, status: "pending", blockedBy: [17, 999] }),
    );
    const view = projectActiveView(state);
    const deps = new Map<number, readonly TaskDependencyPresentation[]>([
      [
        18,
        [
          { id: 17, kind: "waiting" },
          { id: 999, kind: "missing" },
        ],
      ],
    ]);
    const lines = formatTodosSnapshot(view, snapCtx(80, deps));
    const blockedLine = lines.find((l) => /○ #18/.test(l));
    assert.ok(blockedLine);
    assert.match(blockedLine!, /← #17 #999\?/);
  });

  it("empty state → empty array (no groups, no summary)", () => {
    assert.deepEqual(
      formatTodosSnapshot(projectActiveView(EMPTY_STATE), snapCtx(80)),
      [],
    );
  });
});

// ── Layer purity ────────────────────────────────────────────────────────

describe("format.ts layer purity (B2)", () => {
  it("does not import graph or projection", async () => {
    const src = await readFile("format.ts", "utf8");
    assert.ok(
      !src.includes('from "./graph"'),
      "format.ts (B2 layer) must not import from graph.ts",
    );
    assert.ok(
      !src.includes('from "./projection"'),
      "format.ts (B2 layer) must not import from projection.ts",
    );
  });
});
