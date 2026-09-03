/**
 * menu-panel.ts — v1.1 command panel (pure data + formatting).
 *
 * Owns the /todos no-args interactive panel: the subcommand catalog
 * (each row carries a Chinese explanation so nothing has to be
 * memorized), the second-level task picker rows, and the headless
 * fallback text. Pure module — no ctx, no IO, no notify; orchestration
 * (select dialogs + dispatch) lives in index.ts `runMenu`.
 *
 * Layer chain:
 *   projection (P0-B frozen) → formatTaskRow (P0-B public primitive)
 *   → menu-panel (v1.1)
 *
 * Module invariants:
 *   1. Reuses frozen public primitives only (`projectActiveView`,
 *      `projectCompleted`, `projectArchived`, `formatTaskRow`). No
 *      semantic re-derivation; no formatter-output decomposition.
 *   2. View rows use the exact frozen B3 verb names (`ready` /
 *      `blocked` / …) so the panel dispatches to the existing read
 *      path without a mapping layer.
 *   3. Task rows are `formatTaskRow` output — the canonical row the
 *      user sees everywhere else. `#id` is recovered by regex; no
 *      hidden data is smuggled through picker strings.
 *   4. Chinese descriptions live in this file only.
 *   5. No mutation/graph semantics: the panel only COMPOSES command
 *      strings / command objects; execution goes through the frozen
 *      dispatch (`runMutationFlow` / `runGraphQuery` /
 *      `runWorkflowQuery` / read path).
 */

import { formatTaskRow } from "./format.ts";
import {
	projectActiveView,
	projectArchived,
	projectCompleted,
} from "./projection.ts";
import type { Task, TaskState } from "./types.ts";

/** Width used for picker task rows (pickers are narrower than 80). */
const ROW_WIDTH = 64;

export const MENU_TITLE = "Todos — 选择操作";

/** Kinds of second-level task pickers. */
export type MenuTaskKind =
	| "finish"
	| "start"
	| "reopen"
	| "archive"
	| "restore"
	| "why"
	| "unlocks"
	| "detail";

interface MenuRow {
	name: string;
	desc: string;
	taskKind?: MenuTaskKind;
}

/** Ordered by expected daily frequency (work loop first, views last). */
const MENU_ROWS: readonly MenuRow[] = [
	{ name: "here", desc: "我现在在做什么（当前任务 + 完成后会解锁什么）" },
	{ name: "finish", desc: "完成任务（从进行中的任务里选）", taskKind: "finish" },
	{ name: "start", desc: "开始任务（从可开始的任务里选）", taskKind: "start" },
	{ name: "next", desc: "现在可以开始哪些任务" },
	{ name: "总览", desc: "全部任务概览（进行中 / 可开始 / 被阻塞）" },
	{ name: "详情", desc: "查看某个任务（说明 / 依赖 / 解锁）", taskKind: "detail" },
	{ name: "why", desc: "某个任务为什么被阻塞", taskKind: "why" },
	{ name: "unlocks", desc: "完成某个任务会解锁什么", taskKind: "unlocks" },
	{ name: "archive", desc: "归档已完成的任务", taskKind: "archive" },
	{ name: "reopen", desc: "重开已完成的任务", taskKind: "reopen" },
	{ name: "restore", desc: "恢复已归档的任务", taskKind: "restore" },
	{ name: "all", desc: "全部任务（含已归档）" },
	{ name: "ready", desc: "可开始的任务列表" },
	{ name: "blocked", desc: "被阻塞的任务列表" },
	{ name: "completed", desc: "已完成的任务列表" },
	{ name: "archived", desc: "已归档的任务列表" },
];

/** Level-1 picker rows: "name — desc" (context-qos panel pattern). */
export function menuRows(): string[] {
	return MENU_ROWS.map((r) => `${r.name} — ${r.desc}`);
}

/** Extract the row name from a picked "name — desc" string. */
export function parseMenuChoice(choice: string): string | undefined {
	const name = String(choice).split(/\s+—/)[0]?.trim();
	return name === "" ? undefined : name;
}

/** Which second-level task picker (if any) a level-1 row needs. */
export function taskKindFor(name: string): MenuTaskKind | undefined {
	return MENU_ROWS.find((r) => r.name === name)?.taskKind;
}

/** Recognize the batch pseudo-rows inside archive/restore pickers. */
export const BATCH_ARCHIVE_ALL = "全部已完成 — 归档所有已完成任务";
export const BATCH_RESTORE_ALL = "全部已归档 — 恢复所有已归档任务";

export function isBatchRow(choice: string): boolean {
	const c = String(choice);
	return c === BATCH_ARCHIVE_ALL || c === BATCH_RESTORE_ALL;
}

/** Picker title for a second-level task picker. */
export function taskPickerTitle(kind: MenuTaskKind): string {
	switch (kind) {
		case "finish":
			return "选择要完成的任务";
		case "start":
			return "选择要开始的任务";
		case "reopen":
			return "选择要重开的任务";
		case "archive":
			return "选择要归档的任务";
		case "restore":
			return "选择要恢复的任务";
		case "why":
			return "选择要查询阻塞原因的任务";
		case "unlocks":
			return "选择要查看解锁后果的任务";
		case "detail":
			return "选择要查看详情的任务";
	}
}

/** Extract `#id` from a picked task row (formatTaskRow output). */
export function parseTaskIdFromChoice(choice: string): number | undefined {
	const m = /#(\d+)/.exec(String(choice));
	if (m === null) return undefined;
	const n = Number(m[1]);
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function rows(tasks: readonly Task[], role: Parameters<typeof formatTaskRow>[1]["role"]): string[] {
	return tasks.map((t) => formatTaskRow(t, { role, width: ROW_WIDTH }));
}

/**
 * Level-2 picker rows for a task kind, derived from ONE durable
 * snapshot. Returns [] when there is nothing to pick (the caller
 * surfaces `emptyTaskNotice`).
 *
 * - archive / restore prepend a batch pseudo-row (equivalent to the
 *   frozen `archive completed` / `restore archived` selectors).
 * - unlocks offers every active task (any of them may have
 *   dependents; the frozen query decides the answer).
 * - detail offers every non-deleted task including archived.
 */
export function buildTaskOptions(
	state: TaskState,
	kind: MenuTaskKind,
): string[] {
	const view = projectActiveView(state);
	switch (kind) {
		case "finish":
			return rows(view.running, "running");
		case "start":
			return rows(view.ready, "ready");
		case "reopen":
			return rows(projectCompleted(state), "completed");
		case "archive":
			return [
				BATCH_ARCHIVE_ALL,
				...rows(projectCompleted(state), "completed"),
			];
		case "restore":
			return [
				BATCH_RESTORE_ALL,
				...rows(projectArchived(state), "archived"),
			];
		case "why":
			return rows(view.blocked, "blocked");
		case "unlocks":
			return [
				...rows(view.running, "running"),
				...rows(view.ready, "ready"),
				...rows(view.blocked, "blocked"),
			];
		case "detail":
			return [
				...rows(view.running, "running"),
				...rows(view.ready, "ready"),
				...rows(view.blocked, "blocked"),
				...rows(projectCompleted(state), "completed"),
				...rows(projectArchived(state), "archived"),
			];
	}
}

/** Notice shown when a second-level picker has nothing to offer. */
export function emptyTaskNotice(kind: MenuTaskKind): string {
	switch (kind) {
		case "finish":
			return "没有进行中的任务";
		case "start":
			return "没有可开始的任务";
		case "reopen":
			return "没有已完成（未归档）的任务";
		case "archive":
			return "没有可归档的任务";
		case "restore":
			return "没有已归档的任务";
		case "why":
			return "没有被阻塞的任务";
		case "unlocks":
			return "没有活跃任务";
		case "detail":
			return "没有任务";
	}
}

/** Notice shown when the user cancels a picker (Esc). */
export function cancelledNotice(): string {
	return "已取消";
}

/** Headless fallback: the catalog as a plain text table. */
export function fallbackMenuText(): string {
	return [
		"用法: /todos <命令>",
		...MENU_ROWS.map((r) => `  ${r.name} — ${r.desc}`),
	].join("\n");
}
