import type { CompressionResult } from "./common.ts";
import { fileNames, lines, unique } from "./common.ts";

export function compressBash(text: string, isError: boolean): CompressionResult {
  const all = lines(text);
  const errors = unique(
    all
      .filter((line) => /\b(?:error|failed|fatal|exception|panic|denied)\b/i.test(line))
      .map((line) => line.trim()),
    20,
  );
  const unresolved = isError || errors.length > 0;
  const head = all.slice(0, 20);
  const tail = all.slice(-30);
  return {
    kind: "command_result",
    extract: unique([...head, ...errors, ...tail], 80).join("\n").slice(0, 12_000),
    summary: {
      headline: unresolved
        ? "Command output contains unresolved errors."
        : "Command completed without a detected error.",
      facts: unique([...head.slice(0, 5), ...tail.slice(-5)], 10),
      decisions: [],
      errors,
      files: fileNames(text),
      symbols: [],
      unresolved: unresolved ? errors : [],
      nextRelevantActions: [],
    },
    unresolved,
    importance: unresolved ? 0.92 : 0.58,
  };
}
