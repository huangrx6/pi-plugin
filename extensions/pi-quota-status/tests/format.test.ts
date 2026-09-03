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

import { C } from "../constants.ts";
import { buildQuotaText, colorForPercent, formatBar, formatDuration } from "../format.ts";
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

describe("colorForPercent (consumed share: higher is worse)", () => {
	it("green under 50, yellow 50–79, red >= 80", () => {
		assert.equal(colorForPercent(0), C.green);
		assert.equal(colorForPercent(49), C.green);
		assert.equal(colorForPercent(50), C.yellow);
		assert.equal(colorForPercent(79), C.yellow);
		assert.equal(colorForPercent(80), C.red);
		assert.equal(colorForPercent(100), C.red);
	});
});

describe("formatBar", () => {
	it("percentage bar: label + percent colored by consumed level, reset countdown dim", () => {
		const bar = formatBar({
			kind: "percentage",
			label: "GLM ",
			percent: 42,
			resetsInMs: 90 * 60_000,
		} satisfies QuotaBar);
		assert.ok(bar.startsWith(C.green), "under-consumed band is green");
		assert.ok(bar.includes("GLM 42%"));
		assert.ok(bar.includes(`${C.dim}(1h30m)${C.reset}`));
	});

	it("percentage bar: null percent renders dim --% placeholder, never 0%", () => {
		const bar = formatBar({ kind: "percentage", label: "GLM ", percent: null });
		assert.ok(bar.startsWith(C.dim));
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
		assert.ok(bar.startsWith(C.dim));
		assert.ok(bar.includes("$12.50"));
	});

	it("text bar: passthrough dim", () => {
		const bar = formatBar({ kind: "text", label: "K ", text: "OK" } satisfies QuotaBar);
		assert.ok(bar.includes("K OK"));
	});
});

describe("buildQuotaText", () => {
	it("empty cache → null (footer stays silent, no placeholder noise)", () => {
		assert.equal(buildQuotaText(), null);
	});
});
