import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ScopeKey } from "./persistence-contract.ts";
import { cleanupTodoStateFiles } from "./state-retention.ts";

const scope = (value: string) => value as ScopeKey;
const filename = (value: ScopeKey) =>
 `${createHash("sha256").update(value).digest("hex")}.json`;

test("cleanup requires age over 30 days and 7-day inactivity and keeps unfinished work", async () => {
 const root = await mkdtemp(join(tmpdir(), "pi-todo-retention-"));
 const current = scope("current");
 const oldCompleted = join(root, "old-completed.json");
 const oldActive = join(root, "old-active.json");
 const oldRecentlyUsed = join(root, "old-recently-used.json");
 const youngInactive = join(root, "young-inactive.json");
 const malformed = join(root, "malformed.json");
 const currentPath = join(root, filename(current));
 const now = Date.UTC(2026, 8, 10);
 const envelope = (status: string, ageDays: number) =>
  JSON.stringify({ state: { tasks: [{ status, createdAt: now - ageDays * 24 * 60 * 60 * 1000 }] } });
 try {
  await Promise.all([
   writeFile(oldCompleted, envelope("completed", 40)),
   writeFile(oldActive, envelope("pending", 40)),
   writeFile(oldRecentlyUsed, envelope("completed", 40)),
   writeFile(youngInactive, envelope("completed", 20)),
   writeFile(malformed, "{"),
   writeFile(currentPath, envelope("completed", 40)),
  ]);
  const inactive = new Date(now - 8 * 24 * 60 * 60 * 1000);
  const recent = new Date(now - 3 * 24 * 60 * 60 * 1000);
  await Promise.all([
   utimes(oldCompleted, inactive, inactive),
   utimes(oldActive, inactive, inactive),
   utimes(oldRecentlyUsed, recent, recent),
   utimes(youngInactive, inactive, inactive),
   utimes(malformed, inactive, inactive),
   utimes(currentPath, inactive, inactive),
  ]);
  const result = await cleanupTodoStateFiles({
   rootDir: root,
   currentScope: current,
   now,
  });
  assert.deepEqual(result, {
   removed: 1,
   keptActive: 1,
   keptRecent: 1,
   keptYoung: 1,
   unreadable: 1,
  });
  await assert.rejects(readFile(oldCompleted), /ENOENT/);
  for (const path of [oldActive, oldRecentlyUsed, youngInactive, malformed, currentPath])
   assert.ok((await readFile(path, "utf8")).length > 0);
 } finally {
  await rm(root, { recursive: true, force: true });
 }
});
