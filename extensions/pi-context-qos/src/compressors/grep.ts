import type { CompressionResult } from "./common.ts";
import { fileNames, lines, unique } from "./common.ts";

export function compressGrep(text: string): CompressionResult {
  const all = lines(text).filter(Boolean);
  const matches = unique(all, 60);
  const files = fileNames(text);
  return {
    kind: "search_result",
    extract: [
      `${all.length} matches across ${files.length || "unknown"} files`,
      ...matches,
    ]
      .join("\n")
      .slice(0, 12_000),
    summary: {
      headline: `Search returned ${all.length} result lines.`,
      facts: matches.slice(0, 12),
      decisions: [],
      errors: [],
      files,
      symbols: [],
      unresolved: [],
      nextRelevantActions: [],
    },
    unresolved: false,
    importance: 0.62,
  };
}
