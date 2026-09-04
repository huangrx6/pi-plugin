import assert from "node:assert/strict";
import test from "node:test";
import { taskActions, taskListRows } from "./task-panel.ts";
import { renderCompactOverlay } from "./overlay.ts";
import { visibleWidth } from "./format.ts";
import type { TaskState } from "./types.ts";
import factory from "./index.ts";
import { commandRegistry, resetHarness, toolDefs } from "./test-harness.ts";

const state: TaskState = { nextId: 5, tasks: [
  { id: 1, subject: "正在处理的长任务名称，保持中文宽度正确", status: "in_progress", createdAt: 0, updatedAt: 0 },
  { id: 2, subject: "被阻塞", status: "pending", blockedBy: [1], createdAt: 0, updatedAt: 0 },
  { id: 3, subject: "已完成", status: "completed", createdAt: 0, updatedAt: 0 },
  { id: 4, subject: "已归档", status: "completed", archivedAt: 1, createdAt: 0, updatedAt: 0 },
] };

test("default list shows current tasks; completed and archived belong to history", () => {
  assert.equal(taskListRows(state).length, 2);
  assert.match(taskListRows(state)[0]!, /#1/);
  assert.equal(taskListRows(state, true).length, 2);
});

test("task list rows sanitize terminal payloads before presenting choices", () => {
  const unsafe: TaskState = { nextId: 2, tasks: [
    { id: 1, subject: "安全\x1b]9;fake\x07标题", status: "pending", createdAt: 0, updatedAt: 0 },
  ] };
  assert.match(taskListRows(unsafe)[0]!, /安全标题/);
  assert.doesNotMatch(taskListRows(unsafe)[0]!, /fake|\x1b/);
});

test("actions are contextual: blocked tasks cannot start and archived tasks restore", () => {
  assert.match(taskActions(state, 1)[0]!, /^finish/);
  assert.ok(!taskActions(state, 2).some(row => /^(start|finish)/.test(row)));
  assert.match(taskActions(state, 3)[0]!, /^reopen/);
  assert.match(taskActions(state, 4)[0]!, /^restore/);
});

test("default task strip stays bounded at narrow terminal widths and hides completed-only work", () => {
  for (const width of [1, 12, 40, 80, 120]) {
    const lines = renderCompactOverlay(state, width);
    assert.ok(lines.length <= 2);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.deepEqual(renderCompactOverlay({ ...state, tasks: state.tasks.filter(task => task.status === "completed") }, 80), []);
});

test("tool display fits a narrow terminal and does not emit task-controlled escapes", () => {
  resetHarness();
  factory(commandRegistry.api);
  const tool = toolDefs[0] as any;
  const theme = { fg: (_color: string, text: string) => text };
  const call = tool.renderCall({ action: "create", subject: "\x1b]9;fake notification\x07很长的任务名称" }, theme);
  assert.ok(call.render(16).every((line: string) => visibleWidth(line) <= 16 && !line.includes("\x1b]") && !line.includes("fake notification")));
  const result = tool.renderResult({ content: [{ text: "▶ #1 非常长的任务名称，用于验证窄窗口显示" }] }, { expanded: true }, theme);
  assert.ok(result.render(16).every((line: string) => visibleWidth(line) <= 16));
  resetHarness();
});
