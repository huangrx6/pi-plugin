/// <reference types="node" />
// Token-boundary regression tests.
//
// The original bug: SKILL_TOKEN_RE ended with an OPTIONAL lookahead
// `(?=[\s.,;!?"')\]}])?` — the trailing `?` made the whole lookahead
// optional, i.e. it asserted nothing. `/review的`, `/api=v2`, and
// `/name中文` all matched and falsely injected skills.

import assert from "node:assert/strict";
import test from "node:test";

import { SKILL_TOKEN_RE, findInlineSkills } from "../index.ts";

function tokens(text: string): string[] {
  return [...text.matchAll(SKILL_TOKEN_RE)].map((m) => m[1]!);
}

function skill(name: string) {
  return {
    name,
    description: `${name} skill`,
    path: `/skills/${name}/SKILL.md`,
    scope: "user" as const,
    source: "",
  };
}

test("token boundary requires whitespace, punctuation, or end of input", () => {
  assert.deepEqual(tokens("/review的"), [], "CJK suffix must not inject");
  assert.deepEqual(tokens("/api=v2"), [], "= is not a boundary");
  assert.deepEqual(tokens("/name中文"), []);
  assert.deepEqual(tokens("/todo;"), ["todo"]);
  assert.deepEqual(tokens("/skill."), ["skill"]);
  assert.deepEqual(tokens("/name"), ["name"], "end of input is a boundary");
});

test("tokens work inside CJK prose and multiple per line", () => {
  assert.deepEqual(tokens("帮我 /design-api 好了"), ["design-api"]);
  assert.deepEqual(tokens("看看/review"), ["review"]);
  assert.deepEqual(tokens("/a /b"), ["a", "b"]);
});

test("findInlineSkills resolves exact then case-insensitive, deduplicated", () => {
  const skills = [skill("review"), skill("design-api"), skill("DeepReview")];
  const hits = (t: string) => findInlineSkills(t, skills).map((s) => s.name);
  assert.deepEqual(hits("/review /design-api"), ["review", "design-api"]);
  assert.deepEqual(hits("/REVIEW"), ["review"], "case-insensitive fallback");
  assert.deepEqual(hits("/review /review"), ["review"], "deduplicated");
  assert.deepEqual(hits("/unknown"), [], "unknown token injects nothing");
});
