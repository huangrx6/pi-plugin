import type { StoredContextItem } from "../types.ts";

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./-]+/u)
      .filter((word) => word.length >= 3),
  );
}

export function taskRelevance(objective: string, item: StoredContextItem): number {
  const target = words(objective);
  if (target.size === 0) return item.relevance;
  const candidate = words(`${item.filePath ?? ""} ${item.searchText}`);
  let overlap = 0;
  for (const word of target) if (candidate.has(word)) overlap++;
  return Math.min(1, 0.2 + (overlap / Math.max(1, target.size)) * 2.4);
}

export function retentionScore(
  item: StoredContextItem,
  objective: string,
  currentTurn: number,
): { score: number; relevance: number } {
  if (item.pinned) return { score: 1, relevance: 1 };
  const relevance = taskRelevance(objective, item);
  const recency = Math.max(0, 1 - (currentTurn - item.lastUsedTurn) / 30);
  const uniqueness = item.duplicateOf ? 0 : 1;
  const causalDependency = item.unresolved ? 1 : item.supersededBy ? 0.15 : 0.55;
  const verification = item.kind === "test_result" || item.kind === "git" ? 1 : 0.4;
  let score =
    0.25 * relevance +
    0.2 * item.importance +
    0.15 * (item.unresolved ? 1 : 0) +
    0.1 * causalDependency +
    0.1 * recency +
    0.1 * uniqueness +
    0.05 * (item.filePath ? 1 : 0.3) +
    0.05 * verification;
  if (item.supersededBy) score -= 0.18;
  if (item.duplicateOf) score -= 0.35;
  return { score: Math.max(0, Math.min(1, score)), relevance };
}
