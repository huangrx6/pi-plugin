import type { StructuredSummary } from "../types.ts";

export interface CompressionResult {
  kind: string;
  extract: string;
  summary: StructuredSummary;
  unresolved: boolean;
  importance: number;
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trimEnd());
}

export function unique(values: string[], limit = 20): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

export function renderSummary(summary: StructuredSummary, ref?: string): string {
  const sections: Array<[string, string[]]> = [
    ["Facts", summary.facts],
    ["Decisions", summary.decisions],
    ["Errors", summary.errors],
    ["Files", summary.files],
    ["Symbols", summary.symbols],
    ["Unresolved", summary.unresolved],
    ["Next", summary.nextRelevantActions],
  ];
  const body = sections
    .filter(([, values]) => values.length > 0)
    .map(([name, values]) => `${name}:\n${values.map((value) => `- ${value}`).join("\n")}`)
    .join("\n");
  return [summary.headline, body, ref ? `raw: ${ref}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function fileNames(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s("'])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+)(?=[:\s)'",]|$)/gm,
  );
  return unique([...matches].map((match) => match[1] ?? ""));
}
