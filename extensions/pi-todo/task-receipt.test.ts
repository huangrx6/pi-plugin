import assert from "node:assert/strict";
import test from "node:test";

import { appendOpenTaskReminder, formatCreationNotice } from "./task-receipt.ts";
import type { Op } from "./reducer.ts";
import type { Task, TodoDetails } from "./types.ts";

const task = (id: number, subject: string, status: Task["status"] = "pending"): Task => ({
 id,
 subject,
 status,
 createdAt: id,
 updatedAt: id,
});

test("creation notice immediately shows a bounded list of generated tasks", () => {
 const details: TodoDetails = {
  tasks: Array.from({ length: 8 }, (_, index) => task(index + 10, `任务 ${index + 1}`)),
  nextId: 18,
 };
 const text = formatCreationNotice(
  { action: "createMany", items: details.tasks.map((item) => ({ subject: item.subject })) },
  details,
  "Created 8",
 );
 assert.match(text ?? "", /已创建 8 个任务/);
 assert.match(text ?? "", /#10 任务 1/);
 assert.match(text ?? "", /#15 任务 6/);
 assert.match(text ?? "", /另有 2 项/);
 assert.doesNotMatch(text ?? "", /#16/);
});

test("completion receipt names preceding open tasks for model reconciliation", () => {
 const state = {
  tasks: [task(1, "前序任务"), task(2, "当前任务", "completed")],
  nextId: 3,
 };
 const text = appendOpenTaskReminder(
  "✓ #2 当前任务",
  { kind: "finish", id: 2 } as Op,
  state,
 );
 assert.match(text, /Still open.*#1 前序任务/);
});
