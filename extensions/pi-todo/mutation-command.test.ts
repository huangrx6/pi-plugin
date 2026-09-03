/**
 * Unit tests for mutation-command.ts (P1-A).
 *
 * Scope: grammar + parseMutationCommand. NO state read, NO policy
 * check, NO selector parsing (that lives in mutation-selector.ts).
 *
 * Critical invariants tested:
 *   1. exact-lowercase keywords (START 12 → SYNTAX)
 *   2. whitespace separator only (comma list unsupported)
 *   3. single-id lifecycle (start 12 13 → SYNTAX)
 *   4. id format: positive safe integer (rejects 0, negative, float, huge)
 *   5. archive/restore require at least one token
 *   6. unknown verb → SYNTAX
 *   7. leading zeros accepted (0012 → 12)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
 isArchiveRestore,
 isLifecycle,
 parseMutationCommand,
} from "./mutation-command.ts";
import { parseSelectorTokens } from "./mutation-selector.ts";

function p(raw: string) {
 return parseMutationCommand(raw);
}

function isOk(r: ReturnType<typeof p>): r is { ok: true; command: any } {
 return r.ok;
}

// ── Lifecycle: start / finish / reopen ──────────────────────────────────────

describe("parseMutationCommand: lifecycle single-id", () => {
 it("start 12 → ok { kind: start, id: 12 }", () => {
  const r = p("start 12");
  assert.equal(r.ok, true);
  if (isOk(r) && isLifecycle(r.command)) {
   assert.equal(r.command.kind, "start");
   assert.equal(r.command.id, 12);
  }
 });

 it("finish 12 → ok", () => {
  const r = p("finish 12");
  assert.equal(r.ok, true);
  if (isOk(r)) assert.equal(r.command.kind, "finish");
 });

 it("reopen 12 → ok", () => {
  const r = p("reopen 12");
  assert.equal(r.ok, true);
  if (isOk(r)) assert.equal(r.command.kind, "reopen");
 });

 it("0012 accepted as 12", () => {
  const r = p("start 0012");
  assert.equal(r.ok, true);
  if (isOk(r) && isLifecycle(r.command)) {
   assert.equal(r.command.id, 12);
  }
 });

 it("extra args → SYNTAX (lifecycle = single id only)", () => {
  assert.equal(p("start 12 13").ok, false);
  assert.equal(p("finish 1 2 3").ok, false);
  assert.equal(p("reopen 12 99").ok, false);
 });

 it("no id → SYNTAX", () => {
  assert.equal(p("start").ok, false);
  assert.equal(p("finish").ok, false);
  assert.equal(p("reopen").ok, false);
 });

 it("negative id → SYNTAX", () => {
  assert.equal(p("start -5").ok, false);
 });

 it("zero id → SYNTAX", () => {
  assert.equal(p("start 0").ok, false);
 });

 it("float id → SYNTAX", () => {
  assert.equal(p("start 1.5").ok, false);
 });

 it("non-numeric id → SYNTAX", () => {
  assert.equal(p("start abc").ok, false);
  assert.equal(p("start completed").ok, false);
 });

 it("empty id token → SYNTAX", () => {
  // "start   " (trailing space, no id after trim)
  assert.equal(p("start   ").ok, false);
 });

 it("large safe integer boundary → accepted", () => {
  const big = String(Number.MAX_SAFE_INTEGER);
  const r = p(`start ${big}`);
  assert.equal(r.ok, true);
  if (isOk(r) && isLifecycle(r.command)) {
   assert.equal(r.command.id, Number.MAX_SAFE_INTEGER);
  }
 });

 it("above safe integer → SYNTAX (parsed via Number.isSafeInteger)", () => {
  const tooBig = String(Number.MAX_SAFE_INTEGER) + "9";
  const r = p(`start ${tooBig}`);
  assert.equal(r.ok, false);
 });
});

// ── Archive / restore: raw tokens ─────────────────────────────────────────

describe("parseMutationCommand: archive/restore raw tokens", () => {
 it("archive completed → ok { kind: archive, rawTokens: [completed] }", () => {
  const r = p("archive completed");
  assert.equal(r.ok, true);
  if (isOk(r) && isArchiveRestore(r.command)) {
   assert.equal(r.command.kind, "archive");
   assert.deepEqual(r.command.rawTokens, ["completed"]);
  }
 });

 it("restore archived → ok", () => {
  const r = p("restore archived");
  assert.equal(r.ok, true);
  if (isOk(r) && isArchiveRestore(r.command)) {
   assert.equal(r.command.kind, "restore");
   assert.deepEqual(r.command.rawTokens, ["archived"]);
  }
 });

 it("archive 12 → ok (single id)", () => {
  const r = p("archive 12");
  assert.equal(r.ok, true);
  if (isOk(r) && isArchiveRestore(r.command)) {
   assert.equal(r.command.kind, "archive");
   assert.deepEqual(r.command.rawTokens, ["12"]);
  }
 });

 it("restore 12 18 21 → ok (multiple ids)", () => {
  const r = p("restore 12 18 21");
  assert.equal(r.ok, true);
  if (isOk(r) && isArchiveRestore(r.command)) {
   assert.equal(r.command.kind, "restore");
   assert.deepEqual(r.command.rawTokens, ["12", "18", "21"]);
  }
 });

 it("archive all → ok { rawTokens: [all] } (parser only; policy rejects)", () => {
  const r = p("archive all");
  assert.equal(r.ok, true);
  if (isOk(r) && isArchiveRestore(r.command)) {
   assert.deepEqual(r.command.rawTokens, ["all"]);
  }
 });

 it("no args after verb → SYNTAX", () => {
  assert.equal(p("archive").ok, false);
  assert.equal(p("restore").ok, false);
 });
});

// ── Case sensitivity + unknown verb ───────────────────────────────────────

describe("parseMutationCommand: keywords exact lowercase", () => {
 it("START 12 → SYNTAX (uppercase verb rejected)", () => {
  assert.equal(p("START 12").ok, false);
 });

 it("Archive completed → SYNTAX", () => {
  assert.equal(p("Archive completed").ok, false);
 });

 it("Restore archived → SYNTAX", () => {
  assert.equal(p("Restore archived").ok, false);
 });

 it("unknown verb → SYNTAX", () => {
  assert.equal(p("foo 12").ok, false);
  assert.equal(p("delete 12").ok, false);
  assert.equal(p("clear").ok, false);
 });

 it("whitespace only → SYNTAX", () => {
  assert.equal(p("").ok, false);
  assert.equal(p("   ").ok, false);
 });
});

// ── Comma list / non-whitespace separator ──────────────────────────────────

describe("parseMutationCommand: separator constraints", () => {
 it("comma list → rejected (lifecycle by command layer, archive/restore by selector layer)", () => {
  // Lifecycle: single integer expected; comma fails at command layer.
  assert.equal(p("start 12,13").ok, false);

  // Archive/restore: command layer accepts as one token, but selector
  // layer rejects ("12,18,21" is not a valid positive integer).
  const r = p("archive 12,18,21");
  assert.equal(r.ok, true);
  if (isOk(r) && isArchiveRestore(r.command)) {
   const sel = parseSelectorTokens(r.command.rawTokens);
   assert.equal(sel, null); // parseSelectorTokens rejects "12,18,21"
  }
 });

 it("+ prefix → SYNTAX (unknown verb)", () => {
  assert.equal(p("+12").ok, false);
 });

 it("multiple spaces between tokens → ok (whitespace tolerated)", () => {
  const r = p("start   12");
  assert.equal(r.ok, true);
  if (isOk(r) && isLifecycle(r.command)) {
   assert.equal(r.command.id, 12);
  }
 });

 it("leading/trailing whitespace → ok", () => {
  assert.equal(p(" start 12").ok, true);
  assert.equal(p("start 12 ").ok, true);
 });
});

// ── Architecture isolation ─────────────────────────────────────────────────

describe("mutation-command: layer purity", () => {
 it("does not import graph / projection / reducer / format / selector", async () => {
  const src = await readFile("mutation-command.ts", "utf8");
  // Strip comments so doc text doesn't trip the check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
   "./graph",
   "./projection",
   "./reducer",
   "./format",
   "./mutation-selector",
  ];
  for (const path of forbidden) {
   assert.ok(
    !code.includes(path),
    `mutation-command.ts contains forbidden import "${path}"`,
   );
  }
 });
});
