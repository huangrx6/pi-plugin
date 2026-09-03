/**
 * menu-panel.test.ts — v1.1 command panel (pure data + formatting).
 *
 * Verifies:
 *   A. Level-1 catalog shape ("name — desc", key rows present).
 *   B. Row parsing / task-kind mapping.
 *   C. Level-2 task rows per kind (canonical formatTaskRow output,
 *      batch rows for archive/restore, empty states).
 *   D. #id extraction, notices, fallback text.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BATCH_ARCHIVE_ALL,
	BATCH_RESTORE_ALL,
	buildTaskOptions,
	cancelledNotice,
	emptyTaskNotice,
	fallbackMenuText,
	isBatchRow,
	menuRows,
	parseMenuChoice,
	parseTaskIdFromChoice,
	taskKindFor,
	taskPickerTitle,
	type MenuTaskKind,
} from "./menu-panel.ts";
import type { Task, TaskState } from "./types.ts";

function mk(
	id: number,
	sub: string,
	status: Task["status"],
	extras: Partial<Task> = {},
): Task {
	return { id, subject: sub, status, createdAt: 0, updatedAt: 0, ...extras };
}

// ── A. Level-1 catalog ───────────────────────────────────────────────

describe("menu-panel: catalog", () => {
	it("every row is 'name — desc' with a non-empty Chinese desc", () => {
		for (const row of menuRows()) {
			assert.match(row, /^[^—]+— .+$/u, `row not in 'name — desc' shape: ${row}`);
		}
	});

	it("contains the key workflow rows (here / finish / start / next / 总览 / detail)", () => {
		const rows = menuRows().join("\n");
		assert.match(rows, /^here — /m);
		assert.match(rows, /^finish — /m);
		assert.match(rows, /^start — /m);
		assert.match(rows, /^next — /m);
		assert.match(rows, /^总览 — /m);
		assert.match(rows, /^详情 — /m);
	});

	it("view rows use exact frozen B3 verbs (ready/blocked/completed/archived/all)", () => {
		const rows = menuRows().join("\n");
		assert.match(rows, /^ready — /m);
		assert.match(rows, /^blocked — /m);
		assert.match(rows, /^completed — /m);
		assert.match(rows, /^archived — /m);
		assert.match(rows, /^all — /m);
	});
});

// ── B. Parsing + mapping ─────────────────────────────────────────────

describe("menu-panel: parse + map", () => {
	it("parseMenuChoice extracts the name before the — separator", () => {
		assert.equal(
			parseMenuChoice("finish — 完成任务（从进行中的任务里选）"),
			"finish",
		);
		assert.equal(parseMenuChoice("总览 — 全部任务概览"), "总览");
	});

	it("taskKindFor maps action rows and returns undefined for immediate rows", () => {
		assert.equal(taskKindFor("finish"), "finish");
		assert.equal(taskKindFor("start"), "start");
		assert.equal(taskKindFor("reopen"), "reopen");
		assert.equal(taskKindFor("archive"), "archive");
		assert.equal(taskKindFor("restore"), "restore");
		assert.equal(taskKindFor("why"), "why");
		assert.equal(taskKindFor("unlocks"), "unlocks");
		assert.equal(taskKindFor("详情"), "detail");
		assert.equal(taskKindFor("here"), undefined);
		assert.equal(taskKindFor("next"), undefined);
		assert.equal(taskKindFor("总览"), undefined);
		assert.equal(taskKindFor("ready"), undefined);
	});

	it("isBatchRow recognizes only the two batch pseudo-rows", () => {
		assert.ok(isBatchRow(BATCH_ARCHIVE_ALL));
		assert.ok(isBatchRow(BATCH_RESTORE_ALL));
		assert.ok(!isBatchRow("▶ #17 some task"));
		assert.ok(!isBatchRow("全部已完成 — something else"));
	});
});

// ── C. Level-2 task rows ─────────────────────────────────────────────

describe("menu-panel: task rows", () => {
	const state: TaskState = {
		tasks: [
			mk(11, "running one", "in_progress"),
			mk(12, "ready one", "pending"),
			mk(13, "blocked one", "pending", { blockedBy: [12] }),
			mk(14, "done one", "completed"),
			mk(15, "archived one", "completed", { archivedAt: 100 }),
		],
		nextId: 100,
	};

	it("finish → running tasks with ▶ rows", () => {
		const rows = buildTaskOptions(state, "finish");
		assert.equal(rows.length, 1);
		assert.match(rows[0]!, /▶ #11 running one/);
	});

	it("start → ready tasks with ◆ rows (blocked excluded)", () => {
		const rows = buildTaskOptions(state, "start");
		assert.equal(rows.length, 1);
		assert.match(rows[0]!, /◆ #12 ready one/);
	});

	it("archive → batch row first + completed (non-archived) rows", () => {
		const rows = buildTaskOptions(state, "archive");
		assert.equal(rows[0], BATCH_ARCHIVE_ALL);
		assert.equal(rows.length, 2);
		assert.match(rows[1]!, /#14 done one/);
	});

	it("restore → batch row first + archived rows", () => {
		const rows = buildTaskOptions(state, "restore");
		assert.equal(rows[0], BATCH_RESTORE_ALL);
		assert.match(rows[1]!, /#15 archived one/);
	});

	it("why → blocked tasks only", () => {
		const rows = buildTaskOptions(state, "why");
		assert.equal(rows.length, 1);
		assert.match(rows[0]!, /#13 blocked one/);
	});

	it("unlocks → all active tasks (running + ready + blocked)", () => {
		const rows = buildTaskOptions(state, "unlocks");
		assert.equal(rows.length, 3);
	});

	it("detail → every non-deleted task including archived", () => {
		const rows = buildTaskOptions(state, "detail");
		assert.equal(rows.length, 5);
	});

	it("empty states return [] (caller surfaces emptyTaskNotice)", () => {
		const empty: TaskState = { tasks: [], nextId: 1 };
		for (const kind of [
			"finish",
			"start",
			"reopen",
			"archive",
			"restore",
			"why",
			"unlocks",
			"detail",
		] as const) {
			// archive/restore still return the batch row when there are no
			// matching tasks — the batch action itself is a frozen no-op
			// ("Nothing to archive."), so the row stays selectable.
			const rows = buildTaskOptions(empty, kind);
			if (kind === "archive" || kind === "restore") {
				assert.equal(rows.length, 1, `${kind} keeps its batch row`);
			} else {
				assert.equal(rows.length, 0, `${kind} should be empty`);
			}
		}
	});
});

// ── D. Notices, extraction, fallback ─────────────────────────────────

describe("menu-panel: notices + fallback", () => {
	it("parseTaskIdFromChoice extracts #id", () => {
		assert.equal(parseTaskIdFromChoice("▶ #17 Implement bootstrap"), 17);
		assert.equal(parseTaskIdFromChoice("◆ #3 ready task"), 3);
		assert.equal(parseTaskIdFromChoice("no id here"), undefined);
		// IDs start at 1; #0 is not a valid task id → undefined.
		assert.equal(parseTaskIdFromChoice("#0 zero"), undefined);
	});

	it("emptyTaskNotice covers every kind with non-empty text", () => {
		const kinds: MenuTaskKind[] = [
			"finish",
			"start",
			"reopen",
			"archive",
			"restore",
			"why",
			"unlocks",
			"detail",
		];
		for (const kind of kinds) {
			assert.ok(emptyTaskNotice(kind).length > 0);
		}
	});

	it("taskPickerTitle covers every kind with non-empty text", () => {
		const kinds: MenuTaskKind[] = [
			"finish",
			"start",
			"reopen",
			"archive",
			"restore",
			"why",
			"unlocks",
			"detail",
		];
		for (const kind of kinds) {
			assert.ok(taskPickerTitle(kind).length > 0);
		}
	});

	it("cancelledNotice returns 已取消", () => {
		assert.equal(cancelledNotice(), "已取消");
	});

	it("fallbackMenuText is a usage table containing every row", () => {
		const text = fallbackMenuText();
		assert.match(text, /^用法: \/todos <命令>$/m);
		assert.match(text, /here — /);
		assert.match(text, /finish — /);
		assert.match(text, /总览 — /);
	});
});
