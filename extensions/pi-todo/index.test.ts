/**
 * Unit tests for pi-todo.
 *
 * Covers the parts changed for the /todos expand|collapse feature:
 *   - store: per-session expanded flag + eviction
 *   - overlay: computeShownTasks and formatOverflowSummary (the pure
 *     helpers extracted so the new expand behavior is testable without
 *     wiring the full setWidget widget API)
 *   - command: /todos subcommand parsing (empty/expand/collapse/status/
 *     unknown) via a minimal ExtensionAPI stub
 *
 * No widget render frames are exercised; the widget API needs the full
 * pi TUI harness. The pure helpers above prove the feature end-to-end
 * (which rows are picked, what the gutter line says).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import factory from "./index.ts";
import {
	commandRegistry,
	notices,
	resetHarness,
} from "./test-harness.ts";

import {
	computeShownTasks,
	formatOverflowSummary,
} from "./overlay.ts";
import {
	__resetState,
	clearExpanded,
	evictSession,
	getExpanded,
	setExpanded,
} from "./store.ts";
import type { Task } from "./types.ts";

// ── store: expanded flag ────────────────────────────────────────────────

describe("store expanded flag", () => {
	afterEach(() => __resetState());

	it("defaults to false for unknown sessions", () => {
		assert.equal(getExpanded("nonexistent"), false);
	});

	it("roundtrips set/get", () => {
		setExpanded("s1", true);
		assert.equal(getExpanded("s1"), true);
		setExpanded("s1", false);
		assert.equal(getExpanded("s1"), false);
	});

	it("isolates state between sessions", () => {
		setExpanded("s1", true);
		assert.equal(getExpanded("s2"), false);
		assert.equal(getExpanded("s1"), true);
	});

	it("clearExpanded removes the flag", () => {
		setExpanded("s1", true);
		clearExpanded("s1");
		assert.equal(getExpanded("s1"), false);
	});

	it("evictSession also clears the expanded flag", () => {
		setExpanded("s1", true);
		evictSession("s1");
		assert.equal(getExpanded("s1"), false);
	});

	it("__resetState clears every session's flag", () => {
		setExpanded("s1", true);
		setExpanded("s2", true);
		__resetState();
		assert.equal(getExpanded("s1"), false);
		assert.equal(getExpanded("s2"), false);
	});
});

// ── overlay: computeShownTasks ──────────────────────────────────────────

const MAX_ROWS = 12;

function mkTask(id: number, status: Task["status"]): Task {
	return { id, subject: `task ${id}`, status };
}

describe("computeShownTasks", () => {
	it("returns every task when below the collapsed cap", () => {
		const visible = Array.from({ length: 5 }, (_, i) => mkTask(i + 1, "pending"));
		const result = computeShownTasks(visible, false, MAX_ROWS);
		assert.deepEqual(result.shown.map((t) => t.id), [1, 2, 3, 4, 5]);
		assert.equal(result.hiddenCompleted, 0);
		assert.equal(result.truncatedTail, 0);
	});

	it("drops completed rows first when over the cap", () => {
		// 8 pending + 5 completed = 13 total. inner = 11, room = 10.
		// All 8 pending fit, then 2 completed fill the remaining slots;
		// 3 completed drop, 0 pending truncated.
		const tasks: Task[] = [
			...Array.from({ length: 8 }, (_, i) => mkTask(i + 1, "pending")),
			...Array.from({ length: 5 }, (_, i) => mkTask(100 + i, "completed")),
		];
		const result = computeShownTasks(tasks, false, MAX_ROWS);
		assert.equal(result.shown.length, 10);
		assert.equal(result.hiddenCompleted, 3);
		assert.equal(result.truncatedTail, 0);
		// Pending rows are kept ahead of completed (the "drop completed first" rule).
		assert.ok(result.shown.slice(0, 8).every((t) => t.status === "pending"));
		assert.ok(result.shown.slice(8).every((t) => t.status === "completed"));
	});

	it("truncates the non-completed tail when even completed fit", () => {
		// 20 pending, 0 completed. room = 10, so 10 fit, 10 truncated.
		const tasks = Array.from({ length: 20 }, (_, i) => mkTask(i + 1, "pending"));
		const result = computeShownTasks(tasks, false, MAX_ROWS);
		assert.equal(result.shown.length, 10);
		assert.deepEqual(result.shown.map((t) => t.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		assert.equal(result.truncatedTail, 10);
		assert.equal(result.hiddenCompleted, 0);
	});

	it("expansion shows every task regardless of count", () => {
		const tasks = Array.from({ length: 50 }, (_, i) => mkTask(i + 1, "pending"));
		const result = computeShownTasks(tasks, true, MAX_ROWS);
		assert.equal(result.shown.length, 50);
		assert.equal(result.hiddenCompleted, 0);
		assert.equal(result.truncatedTail, 0);
	});

	it("expansion shows no truncation even with mixed status", () => {
		const tasks: Task[] = [
			...Array.from({ length: 30 }, (_, i) => mkTask(i + 1, "pending")),
			...Array.from({ length: 30 }, (_, i) => mkTask(100 + i, "completed")),
		];
		const result = computeShownTasks(tasks, true, MAX_ROWS);
		assert.equal(result.shown.length, 60);
		assert.equal(result.hiddenCompleted, 0);
		assert.equal(result.truncatedTail, 0);
	});

	it("expansion at the boundary (visible.length === inner) is identical to collapsed", () => {
		const tasks = Array.from({ length: 11 }, (_, i) => mkTask(i + 1, "pending"));
		const collapsed = computeShownTasks(tasks, false, MAX_ROWS);
		const expanded = computeShownTasks(tasks, true, MAX_ROWS);
		assert.deepEqual(collapsed.shown.map((t) => t.id), expanded.shown.map((t) => t.id));
		assert.equal(collapsed.hiddenCompleted, expanded.hiddenCompleted);
		assert.equal(collapsed.truncatedTail, expanded.truncatedTail);
	});
});

// ── overlay: formatOverflowSummary ──────────────────────────────────────

const dimTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
};

describe("formatOverflowSummary", () => {
	it("returns null when collapsed and nothing hidden", () => {
		assert.equal(formatOverflowSummary(0, 0, false, dimTheme), null);
	});

	it("renders '+N more' with the expand hint when collapsed and overflowed", () => {
		const out = formatOverflowSummary(3, 2, false, dimTheme);
		assert.ok(out !== null);
		assert.match(out!, /\+5 more \(3 completed, 2 pending\)/);
		assert.match(out!, /\/todos expand/);
	});

	it("omits the completed segment when none are hidden", () => {
		const out = formatOverflowSummary(0, 4, false, dimTheme);
		assert.ok(out !== null);
		assert.match(out!, /\+4 more \(4 pending\)/);
		assert.doesNotMatch(out!, /completed/);
	});

	it("omits the pending segment when none are truncated", () => {
		const out = formatOverflowSummary(7, 0, false, dimTheme);
		assert.ok(out !== null);
		assert.match(out!, /\+7 more \(7 completed\)/);
		assert.doesNotMatch(out!, /pending/);
	});

	it("always renders the collapse hint when expanded (even with nothing hidden)", () => {
		const out = formatOverflowSummary(0, 0, true, dimTheme);
		assert.ok(out !== null);
		assert.match(out!, /\/todos collapse/);
	});

	it("ignores hidden counts when expanded (they're all shown)", () => {
		const out = formatOverflowSummary(99, 99, true, dimTheme);
		assert.ok(out !== null);
		assert.match(out!, /\/todos collapse/);
		assert.doesNotMatch(out!, /\+/);
	});
});

// ── /todos command subcommand parsing ───────────────────────────────────

describe("/todos command", () => {
	beforeEach(() => {
		resetHarness();
		factory(commandRegistry.api);
	});
	afterEach(() => __resetState());

	function callTodos(args: string): { notices: Array<{ message: string; level: string | undefined }> } {
		notices.length = 0;
		commandRegistry.handlers.get("todos")?.(args, commandRegistry.ctx);
		return { notices: [...notices] };
	}

	it("empty args show the existing list (or 'no todos' for an empty session)", () => {
		const r = callTodos("");
		assert.equal(r.notices.length, 1);
		assert.match(r.notices[0]?.message ?? "", /No todos yet/);
	});

	it("expand toggles the per-session expanded flag to true", () => {
		callTodos("expand");
		assert.equal(notices.length, 1);
		assert.match(notices[0]?.message ?? "", /Overlay expanded/);
		// Verify the flag actually flipped.
		assert.equal(getExpanded(commandRegistry.sessionId), true);
	});

	it("collapse toggles the per-session expanded flag back to false", () => {
		setExpanded(commandRegistry.sessionId, true);
		callTodos("collapse");
		assert.match(notices[0]?.message ?? "", /Overlay collapsed/);
		assert.equal(getExpanded(commandRegistry.sessionId), false);
	});

	it("status reports the current expanded state", () => {
		callTodos("status");
		assert.match(notices[0]?.message ?? "", /Overlay: collapsed/);
		setExpanded(commandRegistry.sessionId, true);
		callTodos("status");
		// callTodos clears the array on entry, so the expanded notice is at [0].
		assert.match(notices[0]?.message ?? "", /Overlay: expanded/);
	});

	it("accepts mixed-case subcommands", () => {
		callTodos("EXPAND");
		assert.match(notices[0]?.message ?? "", /Overlay expanded/);
		assert.equal(getExpanded(commandRegistry.sessionId), true);
	});

	it("rejects unknown subcommands with an error notice", () => {
		callTodos("bogus");
		assert.match(notices[0]?.message ?? "", /Unknown subcommand/);
	});

	it("rejects in non-interactive mode (no hasUI)", () => {
		commandRegistry.setInteractive(false);
		callTodos("expand");
		assert.match(notices[0]?.message ?? "", /requires interactive mode/);
		commandRegistry.setInteractive(true);
	});
});