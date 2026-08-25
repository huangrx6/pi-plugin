// matcher.js unit tests: boundary rules, nesting, signal groups.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findTerms,
  matchSignalGroups,
  matchTerms,
  matchedTerms,
  toSignalGroups,
} from "../src/core/matcher.js";

test("latin terms require word-char boundaries", () => {
  assert.deepEqual([...matchTerms("assorted classic", ["ass"])].length, 0);
  assert.deepEqual(matchedTerms("classic theme", ["classic"]), ["classic"]);
  // "bug" must not match inside "debug"
  assert.deepEqual(matchedTerms("debug this", ["bug"]), []);
});

test("CJK nesting resolves longest-match-first", () => {
  assert.deepEqual(matchedTerms("架构设计", ["架构", "架构设计"]), [
    "架构设计",
  ]);
});

test("latin nesting resolves longest-match-first", () => {
  assert.deepEqual(
    matchedTerms("reproduction steps", ["prod", "production", "reproduction"]),
    ["reproduction"],
  );
  // Boundary rule: production/prod inside "reproduction" must NOT match
  // (the v0.13 risk:high false-positive family).
  assert.deepEqual(
    matchedTerms("reproduction steps", ["prod", "production"]),
    [],
  );
});

test("findTerms returns positional hits in order", () => {
  const hits = findTerms("fix the login bug in parser", ["fix", "bug"]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].term, "fix");
  assert.equal(hits[1].term, "bug");
  assert.ok(hits[0].idx < hits[1].idx);
});

test("toSignalGroups accepts flat lists and group objects", () => {
  const flat = toSignalGroups(["api", "接口"]);
  assert.equal(flat.length, 2);
  assert.deepEqual(flat[0], { id: "api", terms: ["api"] });

  const grouped = toSignalGroups([{ group: "api", terms: ["api", "接口"] }]);
  assert.deepEqual(grouped, [{ id: "api", terms: ["api", "接口"] }]);
});

test("same-group aliases count as ONE signal", () => {
  const groups = toSignalGroups([
    { group: "api", terms: ["api", "接口", "endpoint"] },
    { group: "framework", terms: ["spring", "controller"] },
  ]);
  // api + 接口 = one signal
  const one = matchSignalGroups("这个 api 和那个接口怎么调用", groups);
  assert.equal(one.score, 1);
  // api + spring = two independent signals
  const two = matchSignalGroups("spring controller 暴露 api", groups);
  assert.equal(two.score, 2);
});

test("word forms inside one group dedupe (debug/debugging)", () => {
  const groups = toSignalGroups([
    { group: "debug-action", terms: ["debug", "debugging", "debugged"] },
  ]);
  assert.equal(matchSignalGroups("debugging the parser", groups).score, 1);
  assert.equal(matchSignalGroups("debug and debugging", groups).score, 1);
});
