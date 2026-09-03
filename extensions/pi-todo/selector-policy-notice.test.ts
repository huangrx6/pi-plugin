/**
 * selector-policy-notice.test.ts — P4-C2 (selector rejection wording).
 *
 * Verifies:
 *   A. Each (command, selector) rejection pair maps to actionable text.
 *   B. Upstream frozen `validateMutationCommand` still rejects the
 *      same inputs (oracle test for "policy unchanged, wording only").
 *   C. Architecture lock: `mutation-selector.ts` does NOT import
 *      `selector-policy-notice.ts`. The dependency direction is
 *      strictly: validation → presentation (LOCK 21, 29).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { formatSelectorPolicyNotice } from "./selector-policy-notice.ts";
import { validateMutationCommand } from "./mutation-selector.ts";
import type { MutationUsageError } from "./types.ts";

describe("selector-policy-notice: wording", () => {
 it("archive + all → 'already-archived tasks' explanation", () => {
  const err: MutationUsageError = {
   code: "SELECTOR_NOT_ALLOWED",
   command: "archive",
   selector: "all",
  };
  const lines = formatSelectorPolicyNotice(err);
  const out = lines.join("\n");
  assert.match(out, /already-archived/);
  assert.match(out, /archive/);
  assert.match(out, /Use task IDs or `completed`/);
 });

 it("archive + archived → 'those tasks are already archived'", () => {
  const err: MutationUsageError = {
   code: "SELECTOR_NOT_ALLOWED",
   command: "archive",
   selector: "archived",
  };
  const out = formatSelectorPolicyNotice(err).join("\n");
  assert.match(out, /already archived/);
  assert.match(out, /Use task IDs or `completed`/);
 });

 it("restore + completed → 'completed tasks are not archived'", () => {
  const err: MutationUsageError = {
   code: "SELECTOR_NOT_ALLOWED",
   command: "restore",
   selector: "completed",
  };
  const out = formatSelectorPolicyNotice(err).join("\n");
  assert.match(out, /not archived/);
  assert.match(out, /Use task IDs or `archived`/);
 });

 it("restore + all → 'target set is archived tasks only'", () => {
  const err: MutationUsageError = {
   code: "SELECTOR_NOT_ALLOWED",
   command: "restore",
   selector: "all",
  };
  const out = formatSelectorPolicyNotice(err).join("\n");
  assert.match(out, /archived tasks/);
  assert.match(out, /Use task IDs or `archived`/);
 });

 it("output explains WHY (not just THAT) for every rejection", () => {
  const cases: ReadonlyArray<MutationUsageError> = [
   { code: "SELECTOR_NOT_ALLOWED", command: "archive", selector: "all" },
   { code: "SELECTOR_NOT_ALLOWED", command: "archive", selector: "archived" },
   { code: "SELECTOR_NOT_ALLOWED", command: "restore", selector: "completed" },
   { code: "SELECTOR_NOT_ALLOWED", command: "restore", selector: "all" },
  ];
  for (const err of cases) {
   const out = formatSelectorPolicyNotice(err).join("\n");
   // Each non-empty line should be substantive (at least 8 chars),
   // not just a terse "not allowed" message. Empty separator lines
   // are allowed as paragraph breaks.
   for (const line of out.split("\n")) {
    if (line === "") continue;
    assert.ok(line.length >= 8, `expected substantive wording, got: "${line}"`);
   }
  }
 });
});

describe("selector-policy-notice: frozen validator oracle", () => {
 it("validateMutationCommand still rejects archive + all (P1-A unchanged)", () => {
  const r = validateMutationCommand({
   kind: "archive",
   selector: { kind: "named", name: "all" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
   assert.equal(r.error.code, "SELECTOR_NOT_ALLOWED");
   assert.equal(r.error.command, "archive");
   assert.equal(r.error.selector, "all");
  }
 });

 it("validateMutationCommand still rejects restore + completed", () => {
  const r = validateMutationCommand({
   kind: "restore",
   selector: { kind: "named", name: "completed" },
  });
  assert.equal(r.ok, false);
 });

 it("validateMutationCommand still accepts archive + completed (policy unchanged)", () => {
  const r = validateMutationCommand({
   kind: "archive",
   selector: { kind: "named", name: "completed" },
  });
  assert.equal(r.ok, true);
 });

 it("validateMutationCommand still accepts restore + archived (policy unchanged)", () => {
  const r = validateMutationCommand({
   kind: "restore",
   selector: { kind: "named", name: "archived" },
  });
  assert.equal(r.ok, true);
 });
});

describe("selector-policy-notice: architecture lock (LOCK 21, 29)", () => {
 it("mutation-selector.ts does NOT import selector-policy-notice (no reverse dependency)", async () => {
  const src = await readFile("mutation-selector.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
   !/\bfrom\s+["']\.\/selector-policy-notice(?:\.ts)?["']/.test(code),
   "mutation-selector.ts must not import selector-policy-notice (LOCK 29: validation → presentation, never reversed)",
  );
 });

 it("selector-policy-notice.ts only imports the narrow MutationUsageError type", async () => {
  const src = await readFile("selector-policy-notice.ts", "utf8");
  // Strip comments before checking for forbidden types — the
  // module's JSDoc explicitly names MutationCliError as something
  // the module does NOT import, which would otherwise trigger a
  // false positive.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Verify it does NOT import broader unions like MutationError /
  // MutationCliError from mutation-format (which would broaden scope).
  assert.ok(
   !/\bfrom\s+["']\.\/mutation-format(?:\.ts)?["']/.test(code),
   "selector-policy-notice.ts must not import from mutation-format (LOCK 21: narrow type only)",
  );
  assert.ok(
   !/\bMutationCliError\b/.test(code),
   "selector-policy-notice.ts must not reference MutationCliError in code (LOCK 21)",
  );
  assert.ok(
   !/\bMutationError\b/.test(code),
   "selector-policy-notice.ts must not reference MutationError in code (LOCK 21)",
  );
 });
});
