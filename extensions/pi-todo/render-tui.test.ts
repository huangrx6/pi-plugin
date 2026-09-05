/**
 * render-tui.test.ts — v0.6 TUI rendering layer.
 *
 * Covers the three surfaces the v0.6 rendering rework touched:
 *
 *   1. format.ts — planTaskRowParts / joinRowParts must be a faithful
 *      decomposition of formatTaskRow (byte-identical across every
 *      tier: full deps, compact deps, no deps, truncated subject,
 *      empty subject, degenerate width).
 *   2. overlay.ts — renderOverlay with NO theme stays byte-identical
 *      to the plain oracle; WITH a theme every presentation segment is
 *      wrapped by the theme's fg and the un-themed content is intact
 *      (the fake theme wraps text so assertions can strip it back).
 *   3. index.ts — todo renderCall/renderResult: collapsed line colored
 *      by marker (+ "(+N)" overflow hint), expanded renders EVERY line,
 *      errors render as error.
 *
 * The fake theme is deliberately the identity-recording kind
 * (\x1b[<color>]…\x1b[0m) so assertions check both the color token
 * requested and the payload text.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	formatTaskRow,
	formatTaskRowStyled,
	joinRowParts,
	planTaskRowParts,
} from "./format.ts";
import { renderOverlay } from "./overlay.ts";
import type { Task, TaskState } from "./types.ts";
import { commandRegistry, resetHarness, toolDefs } from "./test-harness.ts";
import createExtension from "./index.ts";

// ── helpers ─────────────────────────────────────────────────────────────

function buildTestTask(
	overrides: Partial<Task> & { id: number; subject?: string },
): Task {
	return {
		id: overrides.id,
		subject: overrides.subject ?? `task ${overrides.id}`,
		status: overrides.status ?? "pending",
		createdAt: overrides.createdAt ?? 0,
		updatedAt: overrides.updatedAt ?? 0,
		...(overrides.blockedBy !== undefined && {
			blockedBy: overrides.blockedBy,
		}),
		...(overrides.archivedAt !== undefined && {
			archivedAt: overrides.archivedAt,
		}),
	};
}

/** Recording fake theme: wraps text in \x1b[<color>]…\x1b[0m so tests can
 *  assert the requested token AND strip the payload back out. */
const fakeTheme = {
	fg(color: string, text: string): string {
		return `\u001b[${color}m${text}\u001b[0m`;
	},
};

function stripAnsi(line: string): string {
	// eslint-disable-next-line no-control-regex
	return line.replace(/\u001b\[[0-9a-z;]*m/g, "");
}

function wrap(color: string, text: string): string {
	return `\u001b[${color}m${text}\u001b[0m`;
}

const ROLE_CASES = [
	"running",
	"ready",
	"blocked",
	"completed",
	"archived",
] as const;

// ── 1. format.ts decomposition invariant ───────────────────────────────

describe("planTaskRowParts ↔ formatTaskRow equivalence", () => {
	it("joinRowParts(formatTaskRow decomposition) is identity across widths and tiers", () => {
		const deps = [
			{ id: 7, kind: "waiting" as const },
			{ id: 8, kind: "waiting" as const },
		];
		for (const role of ROLE_CASES) {
			for (const width of [0, 3, 6, 8, 10, 12, 16, 20, 24, 30, 40, 64]) {
				for (const task of [
					buildTestTask({ id: 1, subject: "plain" }),
					buildTestTask({ id: 2, subject: "" }),
					buildTestTask({ id: 3, subject: "很长的中文主题需要被截断的场景测试" }),
					buildTestTask({ id: 4, subject: "with deps", blockedBy: [7, 8] }),
				]) {
					const ctx = { role, width, dependencies: deps };
					const rendered = formatTaskRow(task, ctx);
					const parts = planTaskRowParts(task, ctx);
					assert.equal(
						parts === null ? "" : joinRowParts(parts),
						rendered,
						`role=${role} width=${width} id=${task.id}`,
					);
				}
			}
		}
	});

	it("empty subject → parts carry prefix only", () => {
		const parts = planTaskRowParts(buildTestTask({ id: 5, subject: "" }), {
			role: "ready",
			width: 40,
		});
		assert.ok(parts);
		assert.equal(parts.subject, "");
		assert.equal(parts.depsSuffix, "");
	});
});

describe("formatTaskRowStyled", () => {
	it("running row: prefix accent, subject plain, deps dim", () => {
		const line = formatTaskRowStyled(
			buildTestTask({ id: 12, subject: "工作", blockedBy: [3] }),
			{ role: "running", width: 64, dependencies: [{ id: 3, kind: "waiting" }] },
			fakeTheme,
		);
		assert.ok(line.startsWith(wrap("accent", "▶ #12")));
		assert.ok(line.includes(" 工作 "));
		assert.ok(line.includes("← #3"));
		// Stripped content equals the plain rendering.
		assert.equal(
			stripAnsi(line),
			formatTaskRow(buildTestTask({ id: 12, subject: "工作", blockedBy: [3] }), {
				role: "running",
				width: 64,
				dependencies: [{ id: 3, kind: "waiting" }],
			}),
		);
	});

	it("role → color mapping (ready text, blocked muted, completed dim, archived dim)", () => {
		const cases: Array<[(typeof ROLE_CASES)[number], string, string]> = [
			["ready", "◆ #1", "text"],
			["blocked", "○ #1", "muted"],
			["completed", "✓ #1", "dim"],
			["archived", "· #1", "dim"],
		];
		for (const [role, prefix, color] of cases) {
			const line = formatTaskRowStyled(
				buildTestTask({ id: 1 }),
				{
					role,
					width: 40,
				},
				fakeTheme,
			);
			assert.ok(line.startsWith(wrap(color, prefix)), `${role}: ${line}`);
		}
	});

	it("width <= 0 → empty string", () => {
		assert.equal(
			formatTaskRowStyled(
				buildTestTask({ id: 1 }),
				{ role: "ready", width: 0 },
				fakeTheme,
			),
			"",
		);
	});
});

// ── 2. overlay themed rendering ────────────────────────────────────────

describe("renderOverlay with theme", () => {
	const state: TaskState = {
		tasks: [
			buildTestTask({ id: 1, subject: "done", status: "completed" }),
			buildTestTask({ id: 17, subject: "x", status: "in_progress" }),
			buildTestTask({ id: 18, subject: "y", status: "pending" }),
			buildTestTask({ id: 19, subject: "z", status: "pending", blockedBy: [18] }),
		],
		nextId: 100,
	};

	it("un-themed output is byte-identical to the themed output stripped of ANSI", () => {
		const plain = renderOverlay(state, 80);
		const themed = renderOverlay(state, 80, fakeTheme);
		assert.equal(plain.length, themed.length);
		for (let i = 0; i < plain.length; i++) {
			assert.equal(stripAnsi(themed[i]!), plain[i], `line ${i}`);
		}
	});

	it("header: Todos accent, counts colored per role, ✓ success", () => {
		const themed = renderOverlay(state, 80, fakeTheme);
		const header = themed[0]!;
		assert.ok(header.includes(wrap("accent", "Todos")));
		assert.ok(header.includes(wrap("accent", "▶1")));
		assert.ok(header.includes(wrap("text", "◆1")));
		assert.ok(header.includes(wrap("muted", "○1")));
		assert.ok(header.includes(wrap("success", "✓1")));
	});

	it("section labels dim; running row prefix accent; blocked deps dim", () => {
		const themed = renderOverlay(state, 80, fakeTheme);
		assert.ok(themed.includes(wrap("dim", "RUNNING")));
		assert.ok(themed.some((l) => l.startsWith(wrap("accent", "▶ #17"))));
		assert.ok(themed.some((l) => l.startsWith(wrap("muted", "○ #19"))));
		assert.ok(themed.some((l) => l.includes(wrap("dim", "← #18"))));
	});

	it("✓ summary line: count success, hint dim", () => {
		const themed = renderOverlay(state, 80, fakeTheme);
		const last = themed[themed.length - 1]!;
		assert.ok(last.includes(wrap("success", "✓ 1 completed")));
		assert.ok(last.includes(wrap("dim", " · /todos completed")));
	});

	it("completed-only state keeps the standalone ✓ summary themed", () => {
		const only: TaskState = {
			tasks: [buildTestTask({ id: 9, subject: "d", status: "completed" })],
			nextId: 10,
		};
		const themed = renderOverlay(only, 80, fakeTheme);
		assert.equal(themed.length, 1);
		assert.ok(themed[0]!.includes(wrap("success", "✓ 1 completed")));
	});
});

// ── 3. todo tool renderCall / renderResult ─────────────────────────────

describe("todo tool TUI renderers (v0.6)", () => {
	let todo: Record<string, unknown>;

	it("setup", () => {
		resetHarness();
		createExtension(commandRegistry.api as never);
		todo = toolDefs.find((d) => d.name === "todo")!;
		assert.ok(todo, "todo tool registered");
	});

	it("renderCall: action in muted, rest dim", () => {
		const theme = todo.renderCall as (
			args: unknown,
			theme: unknown,
		) => { render(w: number): string[] };
		const comp = theme({ action: "create", subject: "写文档" }, fakeTheme);
		const line = comp.render(80)[0]!;
		assert.ok(line.startsWith(wrap("dim", "todo ")));
		assert.ok(line.includes(wrap("muted", "create")));
		assert.ok(line.includes("写文档"));
	});

	it("renderResult collapsed: marker-colored first line + muted (+N)", () => {
		const render = todo.renderResult as (
			result: unknown,
			opts: { expanded: boolean },
			theme: unknown,
		) => { render(w: number): string[] };
		const result = {
			content: [
				{
					type: "text",
					text: "▶ #1 alpha\n◆ #2 beta\n○ #3 gamma",
				},
			],
		};
		const comp = render(result, { expanded: false }, fakeTheme);
		const line = comp.render(80)[0]!;
		assert.ok(line.startsWith(wrap("accent", "▶ #1 alpha")));
		assert.ok(line.endsWith(wrap("muted", " (+2)")));
	});

	it("renderResult expanded: every line rendered, each colored by marker", () => {
		const render = todo.renderResult as (
			result: unknown,
			opts: { expanded: boolean },
			theme: unknown,
		) => { render(w: number): string[] };
		const result = {
			content: [
				{
					type: "text",
					text: "▶ #1 alpha\n✓ #2 beta done\nError: boom",
				},
			],
		};
		const comp = render(result, { expanded: true }, fakeTheme);
		const lines = comp.render(80);
		assert.equal(lines.length, 3);
		assert.equal(lines[0], wrap("accent", "▶ #1 alpha"));
		assert.equal(lines[1], wrap("success", "✓ #2 beta done"));
		assert.equal(lines[2], wrap("error", "Error: boom"));
	});

	it("renderResult single-line result has no (+N) hint", () => {
		const render = todo.renderResult as (
			result: unknown,
			opts: { expanded: boolean },
			theme: unknown,
		) => { render(w: number): string[] };
		const comp = render(
			{ content: [{ type: "text", text: "✓ #7 完成" }] },
			{ expanded: false },
			fakeTheme,
		);
		assert.equal(comp.render(80)[0], wrap("success", "✓ #7 完成"));
	});
});

// ── 4. pi 0.85 component contract ─────────────────────────────────────

describe("tool renderers satisfy the pi 0.85 Component contract", () => {
	// pi 0.85 wraps tool renderer output in a MouseRegion whose
	// invalidate() calls child.invalidate() unconditionally (mouse
	// click-to-expand). A bare { render } literal crashed the whole
	// TUI at startup with "this.child.invalidate is not a function".
	let todo: Record<string, unknown>;

	it("setup", () => {
		resetHarness();
		createExtension(commandRegistry.api as never);
		todo = toolDefs.find((d) => d.name === "todo")!;
		assert.ok(todo, "todo tool registered");
	});

	it("renderCall / renderResult always return a full Component (render + invalidate)", () => {
		const asRenderer = (fn: unknown) =>
			fn as (...args: unknown[]) => { render(w: number): string[]; invalidate?(): void };
		const cases: Array<{ name: string; comp: { render(w: number): string[]; invalidate?(): void } }> = [
			{
				name: "renderCall",
				comp: asRenderer(todo.renderCall)({ action: "create", subject: "x" }, fakeTheme),
			},
			{
				name: "renderResult collapsed",
				comp: asRenderer(todo.renderResult)(
					{ content: [{ type: "text", text: "▶ #1 a\n◆ #2 b" }] },
					{ expanded: false },
					fakeTheme,
				),
			},
			{
				name: "renderResult expanded",
				comp: asRenderer(todo.renderResult)(
					{ content: [{ type: "text", text: "✓ #1 a" }] },
					{ expanded: true },
					fakeTheme,
				),
			},
		];
		for (const { name, comp } of cases) {
			assert.equal(typeof comp.render, "function", `${name}.render`);
			assert.equal(typeof comp.invalidate, "function", `${name}.invalidate (pi 0.85 MouseRegion contract)`);
			assert.doesNotThrow(() => comp.invalidate!(), `${name}.invalidate() must be callable`);
			assert.ok(Array.isArray(comp.render(80)), `${name}.render(80) returns string[]`);
		}
	});
});
