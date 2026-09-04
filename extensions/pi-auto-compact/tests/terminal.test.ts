import assert from "node:assert/strict";
import test from "node:test";

import {
  displayWidth,
  sanitizeTerminalText,
  truncateTerminalText,
  wrapTerminalText,
} from "../terminal.ts";

test("terminal text removes CSI, OSC, DCS and bidi controls", () => {
  const unsafe = "safe\x1b[31m red\x1b[0m\x1b]2;title\x07\x1bPpayload\x1b\\\u202e";
  assert.equal(sanitizeTerminalText(unsafe), "safe red");
});

test("wrapping and truncation honor CJK, emoji and combining graphemes", () => {
  assert.deepEqual(wrapTerminalText("中文测试abcdef", 8), ["中文测试", "abcdef"]);
  assert.deepEqual(wrapTerminalText("A👩‍💻e\u0301中", 4), ["A👩‍💻é", "中"]);
  assert.ok(wrapTerminalText("中文👩‍💻abc", 4).every(line => displayWidth(line) <= 4));
  const truncated = truncateTerminalText("上下文👩‍💻abcdef", 8);
  assert.ok(displayWidth(truncated) <= 8);
  assert.match(truncated, /…$/);
});
