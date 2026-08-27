import type { CompressionResult } from "./common.ts";
import { lines, unique } from "./common.ts";

export function compressRead(
  text: string,
  filePath: string | null,
): CompressionResult {
  const all = lines(text);
  const declarations = unique(
    all
      .filter((line) =>
        /\b(?:class|interface|type|function|def|export|const|let|var|struct|enum)\b/.test(
          line,
        ),
      )
      .map((line) => line.trim()),
    30,
  );
  return {
    kind: "file_read",
    extract: [
      filePath ? `File: ${filePath}` : "",
      `Lines: ${all.length}`,
      ...declarations,
    ]
      .filter(Boolean)
      .join("\n"),
    summary: {
      headline: filePath ? `Read ${filePath}.` : "Read source content.",
      facts: [`${all.length} lines`, ...declarations.slice(0, 10)],
      decisions: [],
      errors: [],
      files: filePath ? [filePath] : [],
      symbols: declarations.slice(0, 20),
      unresolved: [],
      nextRelevantActions: [],
    },
    unresolved: false,
    importance: 0.72,
  };
}
