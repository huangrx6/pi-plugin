import type { CompressionResult } from "./common.ts";
import { fileNames, lines, unique } from "./common.ts";

const FAILURE = /(?:FAIL(?:ED)?|ERROR|AssertionError|×|✗)/i;
const SUMMARY = /(?:\d+\s+(?:passed|failed|error|skipped)|Tests?:\s*\d+)/i;

export function compressTests(text: string): CompressionResult {
  const all = lines(text);
  const errors = unique(
    all.filter((line) => FAILURE.test(line)).map((line) => line.trim()),
    16,
  );
  const summaries = unique(
    all.filter((line) => SUMMARY.test(line)).map((line) => line.trim()),
    8,
  );
  const failureIndexes = all
    .map((line, index) => (FAILURE.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const relevant = unique(
    failureIndexes.flatMap((index) => all.slice(Math.max(0, index - 1), index + 5)),
    80,
  );
  const unresolved = errors.length > 0 || /\bfailed\b/i.test(summaries.join(" "));
  return {
    kind: "test_result",
    extract: [...summaries, ...relevant].join("\n").slice(0, 12_000),
    summary: {
      headline: unresolved ? "Test run has unresolved failures." : "Test run completed successfully.",
      facts: summaries,
      decisions: [],
      errors,
      files: fileNames(text),
      symbols: [],
      unresolved: unresolved ? errors.slice(0, 8) : [],
      nextRelevantActions: [],
    },
    unresolved,
    importance: unresolved ? 0.96 : 0.82,
  };
}
