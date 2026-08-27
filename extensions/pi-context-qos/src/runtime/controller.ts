import { randomUUID } from "node:crypto";

import { loadConfig } from "../config.ts";
import { BlobStore } from "../storage/blob-store.ts";
import { ContextDatabase } from "../storage/database.ts";
import { collectGarbage, type GcResult } from "../storage/gc.ts";
import type {
  ContextQosConfig,
  ContextStats,
  ContextTier,
  LooseMessage,
  PressureLevel,
  Representation,
  StoredContextItem,
} from "../types.ts";
import { ArchiveService } from "./archive.ts";
import { epochSummary, planContext, type ContextPlanResult } from "./context.ts";
import { calculatePressure } from "./pressure.ts";
import { estimateMessages } from "./tokens.ts";

const TIERS: ContextTier[] = [
  "pinned",
  "working",
  "evidence",
  "historical",
  "disposable",
];
const REPRESENTATIONS: Representation[] = ["raw", "extract", "summary", "tombstone"];

export interface SessionDescriptor {
  id: string;
  sessionPath: string | null;
  projectRoot: string;
  model: string | null;
  contextWindow: number | null;
}

export class ContextQosController {
  readonly config: ContextQosConfig;
  readonly db: ContextDatabase;
  readonly blobs: BlobStore;
  readonly archiveService: ArchiveService;
  readonly session: SessionDescriptor;
  objective = "";
  visibleEntryIds = new Set<string>();
  lastPlan: ContextPlanResult | null = null;

  constructor(input: SessionDescriptor & { projectTrusted: boolean }) {
    this.config = loadConfig(input.projectRoot, input.projectTrusted);
    this.db = new ContextDatabase(this.config.storage.directory);
    this.blobs = new BlobStore(this.config.storage.directory);
    this.archiveService = new ArchiveService(this.config, this.db, this.blobs);
    this.session = input;
    this.db.upsertSession(input);
    this.objective = this.db.activeTaskObjective(input.id);
    collectGarbage(this.db, this.blobs, this.config);
  }

  close(): void {
    this.db.close();
  }

  setVisibleEntries(entries: Iterable<unknown>): void {
    const visible = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string") visible.add(id);
    }
    this.visibleEntryIds = visible;
  }

  inheritFork(previousSessionPath: string): number {
    const sources = this.db
      .listItemsBySessionPath(previousSessionPath)
      .filter(
        (source) =>
          (source.originEntryId === null ||
            this.visibleEntryIds.has(source.originEntryId)) &&
          !this.db.getItemByToolCall(this.session.id, source.toolCallId),
      );
    const idMap = new Map(sources.map((source) => [source.id, randomUUID()]));
    for (const source of sources) {
      const id = idMap.get(source.id)!;
      const oldRef = `ctx://item/${source.id}`;
      const newRef = `ctx://item/${id}`;
      this.db.insertItem({
        ...source,
        id,
        sessionId: this.session.id,
        taskId: null,
        supersededBy: source.supersededBy
          ? (idMap.get(source.supersededBy) ?? null)
          : null,
        duplicateOf: source.duplicateOf
          ? (idMap.get(source.duplicateOf) ?? null)
          : null,
        summaryText: source.summaryText.replaceAll(oldRef, newRef),
        searchText: source.searchText.replaceAll(oldRef, newRef),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    return sources.length;
  }

  state() {
    return this.db.sessionState(this.session.id);
  }

  beginTurn(objective?: string): number {
    const state = this.state();
    const turn = state.turn + 1;
    this.db.setTurn(this.session.id, turn);
    if (objective?.trim()) {
      this.objective = objective.trim();
      this.db.upsertTask(this.session.id, turn, this.objective);
    }
    return turn;
  }

  setObjective(objective: string): void {
    if (!objective.trim()) return;
    this.objective = objective.trim();
    this.db.upsertTask(this.session.id, this.state().turn, this.objective);
  }

  archiveToolResult(input: {
    originEntryId: string | null;
    toolCallId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    rawText: string;
    isError: boolean;
  }): StoredContextItem {
    const state = this.state();
    const item = this.archiveService.archive(
      {
        sessionId: this.session.id,
        taskId: state.activeTaskId,
        turn: state.turn,
        ...input,
        input: input.toolInput,
      },
      this.visibleEntryIds,
    );
    if (this.db.storageBytes() > this.config.storage.maxBytes) {
      collectGarbage(this.db, this.blobs, this.config);
    }
    return item;
  }

  plan(
    messages: LooseMessage[],
    usageTokens: number | null,
    model: unknown,
  ): ContextPlanResult {
    const state = this.state();
    const plan = planContext({
      messages,
      usageTokens,
      model,
      config: this.config,
      db: this.db,
      sessionId: this.session.id,
      objective: this.objective,
      currentTurn: state.turn,
      visibleEntryIds: this.visibleEntryIds,
      frozen: state.frozen,
    });
    this.lastPlan = plan;
    return plan;
  }

  maybeCloseEpoch(): number | null {
    const state = this.state();
    if (state.turn === 0 || state.turn % this.config.epochs.maxTurns !== 0) {
      return null;
    }
    const items = this.db.listItems(this.session.id).filter((item) => {
      const epochStart = state.turn - this.config.epochs.maxTurns + 1;
      return item.createdTurn >= epochStart && item.createdTurn <= state.turn;
    });
    return this.db.closeEpoch(
      this.session.id,
      state.turn,
      epochSummary(items, state.currentEpoch),
    );
  }

  getItem(ref: string): StoredContextItem | null {
    const id = ref.trim().replace(/^ctx:\/\/item\//, "");
    const item = this.db.getItemById(id);
    if (!item || item.sessionId !== this.session.id) return null;
    if (item.originEntryId && !this.visibleEntryIds.has(item.originEntryId)) return null;
    return item;
  }

  recall(ref: string): string {
    const item = this.getItem(ref);
    if (!item) throw new Error(`Context ref not found on this branch: ${ref}`);
    this.db.touchItem(item.id, this.state().turn);
    if (!item.blobHash || !this.blobs.has(item.blobHash)) {
      return `${item.summaryText}\n[Raw content was not archived or has been garbage-collected.]`;
    }
    try {
      this.db.touchBlob(item.blobHash);
      return this.blobs.get(item.blobHash);
    } catch {
      return `${item.summaryText}\n[Raw content became unavailable during recall.]`;
    }
  }

  search(query: string, limit = 10): StoredContextItem[] {
    const terms = query.match(/[\p{L}\p{N}_./-]+/gu) ?? [];
    if (terms.length === 0) return [];
    const fts = terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    return this.db
      .search(this.session.id, fts, limit * 3)
      .filter(
        (item) =>
          item.originEntryId === null || this.visibleEntryIds.has(item.originEntryId),
      )
      .slice(0, limit);
  }

  pin(ref: string, pinned: boolean): boolean {
    const item = this.getItem(ref);
    return item ? this.db.setPinned(item.id, pinned) : false;
  }

  freeze(frozen: boolean): void {
    this.db.setFrozen(this.session.id, frozen);
  }

  gc(aggressive = false): GcResult {
    return collectGarbage(this.db, this.blobs, this.config, aggressive);
  }

  reset(): void {
    this.db.resetSession(this.session.id);
    this.db.upsertSession(this.session);
  }

  stats(messages: LooseMessage[] = [], model: unknown = null): ContextStats {
    const items = this.db.listItems(this.session.id);
    const activeTokens = messages.length
      ? estimateMessages(messages)
      : (this.lastPlan?.afterTokens ?? items.reduce((sum, item) => sum + item.activeTokens, 0));
    const rawTokens = items.reduce((sum, item) => sum + item.rawTokens, 0);
    const window =
      model && typeof model === "object" && typeof (model as Record<string, unknown>).contextWindow === "number"
        ? Number((model as Record<string, unknown>).contextWindow)
        : (this.session.contextWindow ?? 128_000);
    const pressure = calculatePressure(activeTokens, window, this.config);
    const byTier = Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<ContextTier, number>;
    const byRepresentation = Object.fromEntries(
      REPRESENTATIONS.map((representation) => [representation, 0]),
    ) as Record<Representation, number>;
    for (const item of items) {
      byTier[item.tier] += item.activeTokens;
      byRepresentation[item.representation] += item.activeTokens;
    }
    return {
      activeTokens,
      rawTokens,
      savedTokens: Math.max(0, rawTokens - items.reduce((sum, item) => sum + item.activeTokens, 0)),
      coldBytes: this.db.storageBytes(),
      itemCount: items.length,
      pressure: pressure.level,
      pressureRatio: pressure.ratio,
      frozen: this.state().frozen,
      byTier,
      byRepresentation,
    };
  }
}

export function pressureLabel(level: PressureLevel): string {
  return level.toUpperCase();
}
