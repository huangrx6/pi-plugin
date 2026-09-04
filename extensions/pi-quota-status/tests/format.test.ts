/**
 * format.test.ts — pure formatting oracle for the quota footer.
 *
 * Covers the pure exports of format.ts (formatDuration / colorForPercent /
 * formatBar / buildQuotaText's empty-cache behavior). Assertions are made
 * against the ANSI constants from constants.ts so failures name the wrong
 * color code, not just "diff".
 *
 * Domain note: `percent` is the CONSUMED share — higher is worse
 * (>=80 red, >=50 yellow, else green). formatDuration only has minute
 * granularity (reset windows are never sub-minute).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildQuotaText,
	formatBar,
	formatDuration,
} from "../format.ts";
import { displayWidth, sanitizeTerminalText, truncateToWidth } from "../ui.ts";
import type { QuotaBar } from "../types.ts";

describe("formatDuration", () => {
	it("minute granularity: 1h30m / 45m / 0m; negative means reset", () => {
		assert.equal(formatDuration(0), "0m");
		assert.equal(formatDuration(45 * 60_000), "45m");
		assert.equal(formatDuration(90 * 60_000), "1h30m");
		assert.equal(formatDuration(-5), "reset");
		assert.equal(formatDuration(Number.NaN), "");
	});
});

describe("formatBar", () => {
	it("percentage bar: plain text lets the host theme own colors", () => {
		const bar = formatBar({
			kind: "percentage",
			label: "GLM ",
			percent: 42,
			resetsInMs: 90 * 60_000,
		} satisfies QuotaBar);
		assert.equal(bar, "GLM 42% (1h30m)");
		assert.doesNotMatch(bar, /\x1b/);
	});

	it("percentage bar: null percent renders dim --% placeholder, never 0%", () => {
		const bar = formatBar({ kind: "percentage", label: "GLM ", percent: null });
		assert.ok(bar.includes("--%"));
		assert.ok(!bar.includes("0%"));
	});

	it("balance bar: neutral dim, amount rendered with currency", () => {
		const bar = formatBar({
			kind: "balance",
			label: "OR ",
			amount: 12.5,
			currency: "$",
		} satisfies QuotaBar);
		assert.ok(bar.includes("$12.50"));
	});

	it("text bar: passthrough dim", () => {
		const bar = formatBar({
			kind: "text",
			label: "K ",
			text: "OK",
		} satisfies QuotaBar);
		assert.ok(bar.includes("K OK"));
	});

	it("removes complete terminal controls before formatting external text", () => {
		const bar = formatBar({
			kind: "text",
			label: "状态:\x1b[31m",
			text: "坏\x1b]52;c;secret\x07正常",
		});
		assert.equal(bar, "状态: 坏 正常");
	});
});

describe("terminal-safe width", () => {
	it("counts Chinese and emoji columns and preserves grapheme clusters", () => {
		assert.equal(displayWidth("额度A"), 5);
		assert.equal(displayWidth("👩‍💻"), 2);
		assert.equal(truncateToWidth("额度设置", 5), "额度…");
		assert.equal(truncateToWidth("👩‍💻任务", 5), "👩‍💻任…");
	});

	it("removes bidi controls and collapses layout-breaking whitespace", () => {
		assert.equal(sanitizeTerminalText("A\u202eB\n C"), "AB C");
	});
});

describe("buildQuotaText", () => {
	it("empty cache → null (footer stays silent, no placeholder noise)", () => {
		assert.equal(buildQuotaText(), null);
	});
});
