import type { CompressionResult } from "./common.ts";
import { fileNames, lines, unique } from "./common.ts";

export function compressGit(text: string): CompressionResult {
  const all = lines(text);
  const changes = unique(
    all
      .filter((line) => /^(?:[ MADRCU?!]{1,2}\s|diff --git|@@|\+\+\+|---)/.test(line))
      .map((line) => line.trim()),
    80,
  );
  const files = fileNames(text);
  return {
    kind: "git",
    extract: changes.join("\n").slice(0, 12_000),
    summary: {
      headline: `Git evidence covering ${files.length} file${files.length === 1 ? "" : "s"}.`,
      facts: changes.slice(0, 12),
      decisions: [],
      errors: [],
      files,
      symbols: [],
      unresolved: [],
      nextRelevantActions: [],
    },
    unresolved: false,
    importance: 0.9,
  };
}
