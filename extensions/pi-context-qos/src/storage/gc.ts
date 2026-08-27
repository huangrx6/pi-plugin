import { existsSync, rmSync } from "node:fs";

import type { ContextQosConfig } from "../types.ts";
import { BlobStore } from "./blob-store.ts";
import { ContextDatabase } from "./database.ts";

export interface GcResult {
  items: number;
  blobs: number;
  bytes: number;
}

export function collectGarbage(
  db: ContextDatabase,
  blobs: BlobStore,
  config: ContextQosConfig,
  aggressive = false,
): GcResult {
  const maxAgeMs = config.storage.maxAgeDays * 86_400_000;
  const cutoff = Date.now() - (aggressive ? Math.min(maxAgeMs, 86_400_000) : maxAgeMs);
  const items = db.deleteExpiredItems(cutoff);
  let removedBlobs = 0;
  let removedBytes = 0;
  const remove = (hash: string, bytes: number) => {
    const path = blobs.pathFor(hash);
    if (existsSync(path)) rmSync(path);
    db.detachBlob(hash);
    removedBlobs++;
    removedBytes += bytes;
  };
  for (const blob of db.orphanBlobs()) remove(blob.hash, blob.bytes);
  let currentBytes = db.storageBytes();
  const target = aggressive
    ? Math.floor(config.storage.maxBytes * 0.75)
    : config.storage.maxBytes;
  if (currentBytes > target) {
    for (const blob of db.blobLru()) {
      if (currentBytes <= target) break;
      remove(blob.hash, blob.bytes);
      currentBytes -= blob.bytes;
    }
  }
  return { items, blobs: removedBlobs, bytes: removedBytes };
}
