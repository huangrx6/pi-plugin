import { randomUUID } from "node:crypto";

import {
  compressToolResult,
  filePathFromInput,
  renderSummary,
  testIdentityFromInput,
} from "../compressors/index.ts";
import { secureForArchive } from "../security/redaction.ts";
import { BlobStore, sha256 } from "../storage/blob-store.ts";
import { ContextDatabase } from "../storage/database.ts";
import type {
  ArchiveCandidate,
  ContextQosConfig,
  ContextTier,
  StoredContextItem,
} from "../types.ts";
import { estimateTokens } from "./tokens.ts";

function initialTier(kind: string, unresolved: boolean): ContextTier {
  if (unresolved) return "evidence";
  if (kind === "test_result" || kind === "git") return "evidence";
  if (kind === "file_read") return "working";
  if (kind === "search_result") return "historical";
  return "disposable";
}

export class ArchiveService {
  constructor(
    readonly config: ContextQosConfig,
    readonly db: ContextDatabase,
    readonly blobs: BlobStore,
  ) {}

  archive(
    candidate: ArchiveCandidate,
    visibleEntryIds?: ReadonlySet<string>,
  ): StoredContextItem {
    const rawHash = sha256(candidate.rawText);
    const filePath = filePathFromInput(candidate.toolName, candidate.input);
    const security = secureForArchive(candidate.rawText, filePath, this.config);
    const compressibleText = security.archive
      ? security.content
      : `[Content from excluded path was not archived: ${filePath ?? "unknown"}]`;
    const compressed = compressToolResult(
      candidate.toolName,
      candidate.input,
      compressibleText,
      candidate.isError,
    );
    const testIdentity = testIdentityFromInput(candidate.toolName, candidate.input);
    const id = randomUUID();
    const ref = `ctx://item/${id}`;
    const extractText = compressed.extract || compressed.summary.headline;
    const summaryText = renderSummary(compressed.summary, security.archive ? ref : undefined);
    const duplicate = this.db.findDuplicate(rawHash);
    let blobHash: string | null = null;
    if (security.archive) {
      const blob = this.blobs.put(security.content);
      blobHash = blob.hash;
      this.db.recordBlob(blob.hash, blob.bytes);
    }
    const now = Date.now();
    const item: StoredContextItem = {
      id,
      sessionId: candidate.sessionId,
      taskId: candidate.taskId,
      originEntryId: candidate.originEntryId,
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
      kind: compressed.kind,
      testIdentity,
      filePath,
      createdTurn: candidate.turn,
      lastUsedTurn: candidate.turn,
      rawHash,
      blobHash,
      rawTokens: estimateTokens(candidate.rawText),
      activeTokens: estimateTokens(candidate.rawText),
      tier: initialTier(compressed.kind, compressed.unresolved),
      representation: "raw",
      importance: compressed.importance,
      relevance: 0.5,
      retentionScore: compressed.importance,
      unresolved: compressed.unresolved,
      pinned: false,
      supersededBy: null,
      duplicateOf: duplicate?.id ?? null,
      extractText,
      summaryText,
      searchText: [
        candidate.toolName,
        filePath ?? "",
        extractText,
        summaryText,
      ].join("\n"),
      archived: security.archive,
      createdAt: now,
      updatedAt: now,
    };
    const branchItems = this.db.listItems(candidate.sessionId).filter(
      (candidateItem) =>
        !visibleEntryIds ||
        candidateItem.originEntryId === null ||
        visibleEntryIds.has(candidateItem.originEntryId),
    );
    const previousFile = filePath
      ? branchItems
          .filter((candidateItem) => candidateItem.filePath === filePath)
          .sort(
            (a, b) =>
              b.createdTurn - a.createdTurn || b.createdAt - a.createdAt,
          )[0] ?? null
      : null;
    this.db.insertItem(item);
    if (previousFile && previousFile.id !== item.id) {
      if (previousFile.rawHash === rawHash) item.duplicateOf = previousFile.id;
      else this.db.markSuperseded(previousFile.id, item.id);
    }
    if (
      compressed.kind === "test_result" &&
      !compressed.unresolved &&
      testIdentity
    ) {
      const resolvedIds = branchItems
        .filter(
          (candidateItem) =>
            candidateItem.kind === "test_result" &&
            candidateItem.unresolved &&
            candidateItem.testIdentity === testIdentity,
        )
        .map((candidateItem) => candidateItem.id);
      this.db.resolveOlderTests(resolvedIds, item.id);
    }
    return item;
  }
}
