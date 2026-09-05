/**
 * layout.test.ts — pure layout oracle for the footer composer.
 *
 * Covers the exported string-layout primitives of layout.ts:
 * Covers terminal-control sanitization, ANSI-aware display width and
 * cell construction used by the category table renderer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	makeCell,
	sanitizeTerminalText,
	visibleWidth,
} from "../layout.ts";

describe("visibleWidth", () => {
	it("plain ASCII counts 1 per char", () => {
		assert.equal(visibleWidth("abc"), 3);
	});

	it("ANSI escapes are invisible", () => {
		assert.equal(visibleWidth("\u001b[31mabc\u001b[0m"), 3);
	});

	it("CJK counts as wide (2 columns)", () => {
		assert.equal(visibleWidth("环境"), 4);
		assert.equal(visibleWidth("a环b"), 4);
	});

	it("emoji presentation sequences count as two columns", () => {
		assert.equal(visibleWidth("©️"), 2);
		assert.equal(visibleWidth("1️⃣"), 2);
	});
});

describe("makeCell", () => {
	it("wraps text into a cell with no extra padding at zero level", () => {
		const cell = makeCell("hello");
		assert.ok(cell.text.includes("hello"));
	});
});

describe("sanitizeTerminalText", () => {
	it("removes CSI, OSC and control bytes while preserving content", () => {
		const unsafe = "ok\u001b[31m red\u001b[0m\u001b]9;notify\u0007\u0000 done";
		assert.equal(sanitizeTerminalText(unsafe), "ok red done");
	});

	it("drops an unterminated OSC payload instead of showing its tail", () => {
		assert.equal(sanitizeTerminalText("safe\u001b]9;unfinished"), "safe");
	});
});
