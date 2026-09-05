/**
 * layout.test.ts — pure layout oracle for the footer composer.
 *
 * Covers the exported string-layout primitives of layout.ts:
 * visibleWidth (ANSI + CJK aware), truncateToWidth (keeps escapes,
 * honors visible width, CJK-safe boundaries) and makeCell. These are
 * the functions the five-row footer composes with; renderTable needs a
 * live Theme/tui and stays covered by its integration surface.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	makeCell,
	renderTable,
	sanitizeTerminalText,
	truncateToWidth,
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

describe("truncateToWidth", () => {
	it("shorter than max → unchanged", () => {
		assert.equal(truncateToWidth("abc", 10), "abc");
	});

	it("exact fit → unchanged, no ellipsis", () => {
		assert.equal(truncateToWidth("abcde", 5), "abcde");
	});

	it("over-wide ASCII → truncated with ellipsis, visible width honored", () => {
		const out = truncateToWidth("abcdefgh", 5);
		assert.equal(visibleWidth(out), 5);
		assert.ok(out.includes("…"));
	});

	it("over-wide CJK truncates on a character boundary (never splits a grapheme)", () => {
		const out = truncateToWidth("环境模型集成配置", 5);
		assert.equal(visibleWidth(out), 5);
		assert.ok(out.startsWith("环境"));
	});

	it("ANSI-colored text truncates but keeps the escapes", () => {
		const colored = "\u001b[31mabcdefgh\u001b[0m";
		const out = truncateToWidth(colored, 5);
		assert.equal(visibleWidth(out), 5);
		assert.ok(out.includes("\u001b[31m"), "color start kept");
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

describe("renderTable", () => {
  it("soft separators and wrapped rows keep content aligned", () => {
    const theme = { fg: (_color: string, text: string) => text };
    assert.deepEqual(renderTable([[makeCell("abc"), makeCell("def")]], 15, theme, ["模型"]), ["模型  abc · def"]);
    assert.deepEqual(renderTable([[makeCell("abc"), makeCell("def")]], 10, theme, ["模型"]), ["模型  abc", "      def"]);
    assert.deepEqual(renderTable([[makeCell("abc")]], 3, theme), ["abc"]);
  });
	it("never renders a row wider than an extremely narrow terminal", () => {
		const theme = { fg: (_color: string, text: string) => text };
		const lines = renderTable([[makeCell("content")]], 3, theme, ["环境："]);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= 3);
	});
});
