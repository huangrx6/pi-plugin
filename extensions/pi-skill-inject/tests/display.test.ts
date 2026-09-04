/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  loadedSkillsText,
  sanitizeInline,
  truncateInline,
} from "../display.ts";

test("skill UI text strips terminal controls", () => {
  assert.equal(
    sanitizeInline("review\u001b]9;notify\u0007\u001b[31m!\u001b[0m"),
    "review!",
  );
  assert.equal(sanitizeInline("safe\u001b]9;unfinished"), "safe");
});

test("skill names truncate by displayed terminal width", () => {
  assert.equal(truncateInline("架构设计规范", 7), "架构设…");
  assert.equal(truncateInline("©️abc", 4), "©️a…");
});

test("loaded skill summary uses a readable vertical list", () => {
  assert.equal(loadedSkillsText([]), "本分支尚未加载技能。");
  assert.equal(loadedSkillsText(["review", "tdd"]), "已加载技能 · 2\n  · review\n  · tdd");
});
