import { renderSummary } from "../compressors/index.ts";
import { ContextDatabase } from "../storage/database.ts";
import type {
  ContextQosConfig,
  LooseMessage,
  PressureLevel,
  Representation,
  StoredContextItem,
} from "../types.ts";
import { calculatePressure } from "./pressure.ts";
import { planRepresentations, protectedToolCallIds } from "./planner.ts";
import { retentionScore } from "./scorer.ts";
import {
  estimateMessages,
  estimateTokens,
  replaceTextContent,
  textFromContent,
} from "./tokens.ts";

export interface ContextPlanResult {
  messages: LooseMessage[];
  level: PressureLevel;
  ratio: number;
  beforeTokens: number;
  afterTokens: number;
  transformed: number;
  overBudget: boolean;
}

function representationText(
  item: StoredContextItem,
  representation: Representation,
): string {
  const ref = `ctx://item/${item.id}`;
  if (representation === "raw") return "";
  if (representation === "extract") {
    return [item.extractText, `raw: ${ref}`].filter(Boolean).join("\n");
  }
  if (representation === "summary") return item.summaryText;
  return `[${item.kind} archived: ${ref}]`;
}

function contextWindow(model: unknown): number {
  if (!model || typeof model !== "object") return 128_000;
  const value = (model as Record<string, unknown>).contextWindow;
  return typeof value === "number" && value > 0 ? value : 128_000;
}

export function planContext(input: {
  messages: LooseMessage[];
  usageTokens: number | null;
  model: unknown;
  config: ContextQosConfig;
  db: ContextDatabase;
  sessionId: string;
  objective: string;
  currentTurn: number;
  visibleEntryIds: Set<string>;
  frozen: boolean;
}): ContextPlanResult {
  const messageTokensBefore = estimateMessages(input.messages);
  const beforeTokens = Math.max(input.usageTokens ?? 0, messageTokensBefore);
  // getContextUsage includes the system prompt and other provider framing that
  // is absent from event.messages. Transformations cannot reclaim that fixed
  // cost, so carry it into the post-plan budget check.
  const fixedTokens = Math.max(0, beforeTokens - messageTokensBefore);
  const pressure = calculatePressure(
    beforeTokens,
    contextWindow(input.model),
    input.config,
  );
  if (!input.config.enabled || input.frozen) {
    return {
      messages: input.messages,
      level: pressure.level,
      ratio: pressure.ratio,
      beforeTokens,
      afterTokens: beforeTokens,
      transformed: 0,
      overBudget: beforeTokens > pressure.effectiveBudget,
    };
  }
  const protectedIds = protectedToolCallIds(
    input.messages,
    input.config.frontier.protectedUserTurns,
    input.config.frontier.protectedCausalBlocks,
  );
  const items = input.db
    .listItems(input.sessionId)
    .filter(
      (item) =>
        item.originEntryId === null || input.visibleEntryIds.has(item.originEntryId),
    );
  const decisions = planRepresentations(
    items,
    pressure.level,
    input.objective,
    input.currentTurn,
    protectedIds,
  );
  const byCall = new Map(decisions.map((decision) => [decision.item.toolCallId, decision]));
  let transformed = 0;
  const messages = input.messages.map((message) => {
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") {
      return message;
    }
    const decision = byCall.get(message.toolCallId);
    if (!decision || decision.representation === "raw") return message;
    const text = representationText(decision.item, decision.representation);
    const original = textFromContent(message.content);
    if (text === original) return message;
    transformed++;
    const { score, relevance } = retentionScore(
      decision.item,
      input.objective,
      input.currentTurn,
    );
    input.db.setRepresentation(
      decision.item.id,
      decision.representation,
      estimateTokens(text),
      score,
      relevance,
    );
    return replaceTextContent(message, text);
  });
  const afterTokens = fixedTokens + estimateMessages(messages);
  return {
    messages,
    level: pressure.level,
    ratio: pressure.ratio,
    beforeTokens,
    afterTokens,
    transformed,
    overBudget: afterTokens > pressure.effectiveBudget,
  };
}

export function epochSummary(items: StoredContextItem[], ordinal: number): string {
  const files = [...new Set(items.map((item) => item.filePath).filter(Boolean))] as string[];
  const unresolved = items.filter((item) => item.unresolved);
  return renderSummary({
    headline: `Frozen context epoch ${ordinal}: ${items.length} archived items.`,
    facts: items.slice(-8).map((item) => `${item.toolName}: ${item.kind}`),
    decisions: [],
    errors: unresolved.flatMap((item) => [item.summaryText.split("\n")[0] ?? ""]),
    files: files.slice(0, 20),
    symbols: [],
    unresolved: unresolved.map((item) => `ctx://item/${item.id}`),
    nextRelevantActions: [],
  });
}
