import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ScopeKey } from "./persistence-contract.ts";

export const DEFAULT_MINIMUM_AGE_DAYS = 30;
export const DEFAULT_INACTIVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StateCleanupResult {
 removed: number;
 keptActive: number;
 keptRecent: number;
 keptYoung: number;
 unreadable: number;
}

function currentFilename(scope: ScopeKey): string {
 return `${createHash("sha256").update(scope).digest("hex")}.json`;
}

function inspectTasks(
 value: unknown,
): { unfinished: boolean; earliestCreatedAt?: number } | undefined {
 if (!value || typeof value !== "object") return undefined;
 const state = (value as { state?: unknown }).state;
 if (!state || typeof state !== "object") return undefined;
 const tasks = (state as { tasks?: unknown }).tasks;
 if (!Array.isArray(tasks)) return undefined;
 let unfinished = false;
 let earliestCreatedAt: number | undefined;
 for (const task of tasks) {
  if (!task || typeof task !== "object") continue;
  const item = task as { status?: unknown; closedAt?: unknown };
  unfinished ||= (
   item.closedAt === undefined &&
   (item.status === "pending" || item.status === "in_progress")
  );
  const createdAt = (task as { createdAt?: unknown }).createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0)
   earliestCreatedAt = Math.min(earliestCreatedAt ?? createdAt, createdAt);
 }
 return { unfinished, earliestCreatedAt };
}

/** Remove ended state only when the session is old and the file is inactive. */
export async function cleanupTodoStateFiles(options: {
 rootDir: string;
 currentScope: ScopeKey;
 minimumAgeDays?: number;
 inactiveDays?: number;
 now?: number;
}): Promise<StateCleanupResult> {
 const result: StateCleanupResult = {
  removed: 0,
  keptActive: 0,
  keptRecent: 0,
  keptYoung: 0,
  unreadable: 0,
 };
 let entries;
 try {
  entries = await readdir(options.rootDir, { withFileTypes: true });
 } catch (error) {
  if ((error as { code?: string }).code === "ENOENT") return result;
  throw error;
 }
 const current = currentFilename(options.currentScope);
 const now = options.now ?? Date.now();
 const ageCutoff = now -
  (options.minimumAgeDays ?? DEFAULT_MINIMUM_AGE_DAYS) * DAY_MS;
 const inactiveCutoff = now -
  (options.inactiveDays ?? DEFAULT_INACTIVE_DAYS) * DAY_MS;

 for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === current)
   continue;
  const path = join(options.rootDir, entry.name);
  let metadata;
  try {
   metadata = await stat(path);
  } catch {
   result.unreadable += 1;
   continue;
  }
  if (metadata.mtimeMs > inactiveCutoff) {
   result.keptRecent += 1;
   continue;
  }
  let inspected: ReturnType<typeof inspectTasks>;
  try {
   inspected = inspectTasks(JSON.parse(await readFile(path, "utf8")));
  } catch {
   inspected = undefined;
  }
  if (inspected === undefined) {
   result.unreadable += 1;
   continue;
  }
  if (inspected.unfinished) {
   result.keptActive += 1;
   continue;
  }
  const createdAt = inspected.earliestCreatedAt ??
   (metadata.birthtimeMs > 0 ? metadata.birthtimeMs : metadata.mtimeMs);
  if (createdAt >= ageCutoff) {
   result.keptYoung += 1;
   continue;
  }
  try {
   await unlink(path);
   result.removed += 1;
  } catch {
   result.unreadable += 1;
  }
 }
 return result;
}
