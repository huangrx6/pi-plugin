/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { formatInline, sanitizeInline } from "../display.ts";

test("terminal-controlled text is safe before it enters dialogs", () => {
  assert.equal(
    sanitizeInline("git\nstatus\u001b]9;notify\u0007\u001b[31m!\u001b[0m"),
    "git status!",
  );
  assert.equal(sanitizeInline("safe\u001b]9;unfinished"), "safe");
});

test("dialog summaries truncate by terminal columns without splitting CJK", () => {
  assert.equal(formatInline("执行危险操作", 7), "执行危…");
  assert.equal(formatInline("abc", 3), "abc");
  assert.equal(formatInline("©️abc", 4), "©️a…");
});
