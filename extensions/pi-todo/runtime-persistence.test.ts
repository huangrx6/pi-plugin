import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionTodoPersistence, resolveDefaultTodoRoot } from "./runtime-persistence.ts";

test("todo always uses the canonical extension state directory", () => {
 const agentDir = mkdtempSync(join(tmpdir(), "todo-paths-"));
 try {
  const legacy = join(agentDir, "pi-todo");
  const current = join(agentDir, "extensions-data", "pi-todo", "state");
  assert.equal(resolveDefaultTodoRoot(agentDir), current);
  mkdirSync(legacy);
  writeFileSync(join(legacy, "workspace.json"), '{"version":1}');
  assert.equal(resolveDefaultTodoRoot(agentDir), current);
  mkdirSync(current, { recursive: true });
  assert.equal(resolveDefaultTodoRoot(agentDir), current);
  assert.equal(createProductionTodoPersistence({ rootDir: legacy }).rootDir, legacy);
 } finally {
  rmSync(agentDir, { recursive: true, force: true });
 }
});
