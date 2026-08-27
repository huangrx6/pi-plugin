import type {
  PlanDecision,
  PressureLevel,
  Representation,
  StoredContextItem,
} from "../types.ts";
import { retentionScore } from "./scorer.ts";

function targetRepresentation(
  item: StoredContextItem,
  pressure: PressureLevel,
  score: number,
): Representation {
  // Hard protections outrank every weighted decision.
  if (item.pinned || item.unresolved) return item.representation;
  if (!item.archived) return "summary";
  if (item.duplicateOf) return "tombstone";
  if (pressure === "green") return item.supersededBy ? "summary" : "raw";
  if (pressure === "yellow") {
    return item.supersededBy || item.tier === "disposable" ? "extract" : "raw";
  }
  if (pressure === "orange") {
    return item.tier === "historical" || item.supersededBy || score < 0.45
      ? "extract"
      : "raw";
  }
  if (pressure === "red") {
    if (score < 0.35 || item.tier === "disposable") return "tombstone";
    if (score < 0.72 || item.tier === "historical") return "summary";
    return "extract";
  }
  if (score < 0.62 || item.tier === "historical" || item.supersededBy) {
    return "tombstone";
  }
  return score < 0.82 ? "summary" : "extract";
}

const REPRESENTATION_RANK: Record<Representation, number> = {
  raw: 0,
  extract: 1,
  summary: 2,
  tombstone: 3,
};

function monotonicRepresentation(
  current: Representation,
  target: Representation,
): Representation {
  return REPRESENTATION_RANK[target] > REPRESENTATION_RANK[current]
    ? target
    : current;
}

export function planRepresentations(
  items: StoredContextItem[],
  pressure: PressureLevel,
  objective: string,
  currentTurn: number,
  protectedToolCalls: Set<string>,
): PlanDecision[] {
  const latestByFile = new Map<string, StoredContextItem>();
  for (const item of items) {
    if (!item.filePath) continue;
    const previous = latestByFile.get(item.filePath);
    if (
      !previous ||
      item.createdTurn > previous.createdTurn ||
      (item.createdTurn === previous.createdTurn && item.createdAt > previous.createdAt)
    ) {
      latestByFile.set(item.filePath, item);
    }
  }
  const latestFileItems = new Set(
    [...latestByFile.values()].map((item) => item.id),
  );
  return items.map((item) => {
    if (protectedToolCalls.has(item.toolCallId) || latestFileItems.has(item.id)) {
      return { item, representation: item.representation };
    }
    const { score } = retentionScore(item, objective, currentTurn);
    const target = targetRepresentation(item, pressure, score);
    return {
      item,
      representation: monotonicRepresentation(item.representation, target),
    };
  });
}

export function protectedToolCallIds(
  messages: Array<{ role?: string; toolCallId?: string }>,
  protectedUserTurns: number,
  protectedCausalBlocks: number,
): Set<string> {
  let userCount = 0;
  let firstProtectedUser = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      userCount++;
      if (userCount === protectedUserTurns) {
        firstProtectedUser = index;
        break;
      }
    }
  }
  const toolIndexes: number[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "toolResult") toolIndexes.push(index);
    if (toolIndexes.length === protectedCausalBlocks) break;
  }
  const firstProtectedTool = toolIndexes.at(-1) ?? messages.length;
  const frontierStart = Math.min(firstProtectedUser, firstProtectedTool);
  return new Set(
    messages
      .slice(frontierStart)
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId)
      .filter((id): id is string => typeof id === "string"),
  );
}
