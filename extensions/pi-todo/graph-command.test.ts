/**
 * Unit tests for graph-command.ts (P2-C lexical grammar).
 *
 * Critical invariants tested (P2-C LOCK):
 *   1. parseGraphCommand returns command / syntax-error / not-graph-command.
 *   2. Existing B3 read commands → not-graph-command (fall through).
 *   3. Mutation commands → not-graph-command (fall through).
 *   4. next requires exactly zero arguments.
 *   5. why / unlocks require exactly one positive safe-integer TaskId.
 *   6. ID lexical policy: 0012 → 12; 0/-1/+1/1.5/1e3/non-numeric/unsafe → undefined.
 *   7. Case variants of graph verbs → syntax-error, never silent fall-through.
 *   8. graph-command.ts imports ONLY types from types.ts (no runtime deps).
 *   9. No user-facing UX strings in source.
 *  10. parseGraphCommand takes `raw: string` only — no other params.
 *
 *   24 tests organized by category.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
 parseGraphCommand,
 type GraphCommand,
 type GraphVerb,
 type ParseGraphCommandResult,
} from "./graph-command.ts";

// ── A. Command recognition (happy paths) — 5 tests ───────────────────

describe("parseGraphCommand: command recognition", () => {
 it("★ 1 'next' → command {kind:'next'}", () => {
  const out = parseGraphCommand("next");
  assert.deepEqual(out, { kind: "command", command: { kind: "next" } });
 });

 it("★ 2 'why 12' → command {kind:'why', id:12}", () => {
  const out = parseGraphCommand("why 12");
  assert.deepEqual(out, {
   kind: "command",
   command: { kind: "why", id: 12 },
  });
 });

 it("★ 3 'unlocks 12' → command {kind:'unlocks', id:12}", () => {
  const out = parseGraphCommand("unlocks 12");
  assert.deepEqual(out, {
   kind: "command",
   command: { kind: "unlocks", id: 12 },
  });
 });

 it("★ 4 'why 0012' → id 12 (leading zeros normalized)", () => {
  const out = parseGraphCommand("why 0012");
  assert.deepEqual(out, {
   kind: "command",
   command: { kind: "why", id: 12 },
  });
 });

 it("★ 5 'unlocks 0012' → id 12 (leading zeros normalized)", () => {
  const out = parseGraphCommand("unlocks 0012");
  assert.deepEqual(out, {
   kind: "command",
   command: { kind: "unlocks", id: 12 },
  });
 });
});

// ── B. next syntax errors — 3 tests ───────────────────────────────────

describe("parseGraphCommand: next syntax errors", () => {
 it("★ 6 'next 12' → syntax-error(next)", () => {
  const out = parseGraphCommand("next 12");
  assert.deepEqual(out, { kind: "syntax-error", verb: "next" });
 });

 it("★ 7 'next ready' → syntax-error(next)", () => {
  const out = parseGraphCommand("next ready");
  assert.deepEqual(out, { kind: "syntax-error", verb: "next" });
 });

 it("★ 8 'NEXT' → syntax-error(next) (case variant)", () => {
  const out = parseGraphCommand("NEXT");
  assert.deepEqual(out, { kind: "syntax-error", verb: "next" });
 });
});

// ── C. why / unlocks syntax errors (table-driven) — 2 tests ───────────

describe("parseGraphCommand: why / unlocks syntax errors", () => {
 // Table-driven matrix covering LOCK §10 lexical policy.
 const whyCases: ReadonlyArray<readonly [string, string]> = [
  ["why", "no arg"],
  ["why 0", "zero"],
  ["why -1", "negative"],
  ["why +12", "signed"],
  ["why 1.5", "fractional"],
  ["why 1e3", "exponential"],
  ["why abc", "non-numeric"],
  ["why 12 13", "too many args"],
  ["why 12,13", "comma-separated"],
  ["why 9007199254740993", "unsafe integer"],
  ["WHY 12", "case variant"],
 ];

 for (const [input, label] of whyCases) {
  it(`★ 9a '${input}' (${label}) → syntax-error(why)`, () => {
   const out = parseGraphCommand(input);
   assert.equal(out.kind, "syntax-error");
   assert.equal(out.verb, "why");
  });
 }

 const unlocksCases: ReadonlyArray<readonly [string, string]> = [
  ["unlocks", "no arg"],
  ["unlocks 0", "zero"],
  ["unlocks abc", "non-numeric"],
  ["unlocks 12 13", "too many args"],
  ["UNLOCKS 12", "case variant"],
 ];

 for (const [input, label] of unlocksCases) {
  it(`★ 9b '${input}' (${label}) → syntax-error(unlocks)`, () => {
   const out = parseGraphCommand(input);
   assert.equal(out.kind, "syntax-error");
   assert.equal(out.verb, "unlocks");
  });
 }
});

// ── D. Whitespace handling — 1 test ───────────────────────────────────

describe("parseGraphCommand: whitespace handling", () => {
 it("★ 10 '  next  ' (padded) → command(next)", () => {
  const out = parseGraphCommand("  next  ");
  assert.deepEqual(out, { kind: "command", command: { kind: "next" } });
 });
});

// ── E. B3 read fall-through (table-driven) — 1 test ──────────────────

describe("parseGraphCommand: B3 read fall-through", () => {
 // All existing B3 read commands must remain eligible for the
 // existing parseTodosCommand path. P2-C MUST NOT swallow them.
 const b3Cases: ReadonlyArray<string> = [
  "",
  "12",
  "ready",
  "blocked",
  "completed",
  "archived",
  "all",
  "expand",
  "collapse",
  "status",
 ];

 for (const input of b3Cases) {
  it(`★ 11 '${input || "<empty>"}' → not-graph-command`, () => {
   const out = parseGraphCommand(input);
   assert.equal(out.kind, "not-graph-command");
  });
 }
});

// ── F. Mutation verb fall-through (table-driven) — 1 test ───────────

describe("parseGraphCommand: mutation verb fall-through", () => {
 const mutationCases: ReadonlyArray<string> = [
  "start 12",
  "finish 12",
  "reopen 12",
  "archive completed",
  "restore archived",
 ];

 for (const input of mutationCases) {
  it(`★ 12 '${input}' → not-graph-command`, () => {
   const out = parseGraphCommand(input);
   assert.equal(out.kind, "not-graph-command");
  });
 }
});

// ── G. Architecture — 5 tests ─────────────────────────────────────────

describe("graph-command: architecture", () => {
 it("★ 13 only type-imports TaskId from types.ts", async () => {
  const src = await readFile("graph-command.ts", "utf8");
  // Must import TaskId from ./types.ts as type-only.
  assert.ok(
   /import\s+type\s*\{[^}]*TaskId[^}]*\}\s*from\s*"\.\/types\.ts"/.test(src),
   'graph-command.ts must use `import type { TaskId } from "./types.ts"`',
  );
  // Must NOT runtime-import anything from types.ts beyond TaskId.
  const runtimeImports = src.match(
   /import\s*\{[^}]+\}\s*from\s*"\.\/types\.ts"/g,
  );
  if (runtimeImports) {
   for (const ri of runtimeImports) {
    assert.fail(`graph-command.ts runtime-imports from types.ts: ${ri}`);
   }
  }
 });

 it("★ 14 no forbidden runtime imports (LOCK §3, §12)", async () => {
  const src = await readFile("graph-command.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const forbidden = [
   "./graph",
   "./projection",
   "./read-model",
   "./format",
   "./reducer",
   "./store",
   "./index",
   "./mutation-command",
   "./mutation-selector",
   "./mutation-executor",
   "./mutation-outcome",
   "./mutation-format",
   "./mutation-wiring",
   "./graph-query",
   "./graph-format",
  ];
  // Boundary-aware: `from "./<module>"` or `from "./<module>/..."` —
  // not `from "./<module>-..."`.
  for (const m of forbidden) {
   const re = new RegExp(`from\\s+["']\\.\\/${m}(?:["']|/)`);
   assert.ok(
    !re.test(code),
    `graph-command.ts contains forbidden module import "${m}"`,
   );
  }
  // No graph verb vocabulary duplicated for index.ts to import.
  assert.ok(
   !/GRAPH_VERBS\s*=/.test(code),
   "GRAPH_VERBS set must not be defined here — index.ts wiring will dispatch",
  );
 });

 it("★ 15 no user-facing UX strings in code (LOCK §13)", async () => {
  const src = await readFile("graph-command.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const bannedStrings = [
   "Invalid graph query",
   "Usage: /todos",
   "not found",
   "Ready",
   "Running",
   "Completed",
   "Archived",
   "Next:",
   "Why",
   "Unlocks",
  ];
  for (const s of bannedStrings) {
   assert.ok(
    !code.includes(s),
    `graph-command.ts contains forbidden UX string "${s}"`,
   );
  }
 });

 it("★ 16 parseGraphCommand signature takes raw:string only", async () => {
  const src = await readFile("graph-command.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const fnMatch = code.match(/function parseGraphCommand\s*\(([^)]*)\)/);
  assert.ok(fnMatch, "parseGraphCommand must be a function declaration");
  const params = fnMatch[1]!.trim();
  assert.ok(
   params.startsWith("raw"),
   `parseGraphCommand must take a single 'raw' parameter, got: ${params}`,
  );
  assert.ok(
   !params.includes(","),
   `parseGraphCommand must take exactly one parameter, got: ${params}`,
  );
 });

 it("★ 17 graph verb vocabulary has single canonical source (no duplicate vocabulary arrays)", async () => {
  // LOCK §4: graph verbs have exactly one lexical source here
  // (the GRAPH_VERB_NAMES Set). No second collection may list all
  // 3 verbs together (no vocabulary duplication).
  //
  // Verb strings legitimately appear in:
  //   - the type GraphVerb union ("next" | "why" | "unlocks")
  //   - the GraphCommand union ("next" kind literal)
  //   - the GRAPH_VERB_NAMES Set (canonical)
  //   - switch cases / return objects (driven by typed narrowing)
  //
  // None of those are vocabulary DUPLICATION — only a SECOND
  // collection that lists all three is forbidden.
  const src = await readFile("graph-command.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  // Find lines that list all 3 verbs together (a vocabulary duplicate).
  const linesWithAllThree = code
   .split("\n")
   .map((line, idx) => ({ line: line.trim(), idx }))
   .filter(
    ({ line }) =>
     line.includes('"next"') &&
     line.includes('"why"') &&
     line.includes('"unlocks"'),
   );
  assert.equal(
   linesWithAllThree.length,
   1,
   `Expected exactly 1 line to list all 3 verbs together (the canonical Set opening bracket). Found ${linesWithAllThree.length}:\n` +
    linesWithAllThree
     .map(({ line, idx }) => `  L${idx + 1}: ${line}`)
     .join("\n"),
  );
  // Verify the canonical Set exists.
  const setMatch = code.match(
   /GRAPH_VERB_NAMES[\s\S]+?new\s+Set[\s\S]+?\)\s*;/,
  );
  assert.ok(setMatch, "GRAPH_VERB_NAMES Set literal must exist");
 });
});
