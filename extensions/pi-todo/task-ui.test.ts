import assert from "node:assert/strict";
import test from "node:test";
import { taskActions } from "./task-actions.ts";
import { renderCompactOverlay, TodoOverlay } from "./overlay.ts";
import { OverlaySnapshotCache } from "./overlay-snapshot-cache.ts";
import type { ScopeKey } from "./persistence-contract.ts";
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

test("actions are contextual: blocked tasks cannot start and archived tasks restore", () => {
  assert.match(taskActions(state, 1)[0]!, /^finish/);
  assert.ok(!taskActions(state, 2).some(row => /^(start|finish)/.test(row)));
  assert.match(taskActions(state, 3)[0]!, /^reopen/);
  assert.match(taskActions(state, 4)[0]!, /^restore/);
});

test("default task strip stays bounded at narrow terminal widths and hides completed-only work", () => {
  for (const width of [1, 12, 40, 80, 120]) {
    const lines = renderCompactOverlay(state, width);
    assert.ok(lines.length <= 4);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  const wide = renderCompactOverlay(state, 120);
  assert.ok(wide[0]?.startsWith("──────┬"));
  assert.match(wide[1] ?? "", /^ 任务 │ /);
  assert.ok(wide.at(-1)?.startsWith("──────┴"));
  assert.ok(wide.every(line => visibleWidth(line) === 120));
  assert.deepEqual(renderCompactOverlay({ ...state, tasks: state.tasks.filter(task => task.status === "completed") }, 80), []);
});

test("task strip is suspended while the task window is open and restores afterward", () => {
  const scope = "task-window" as ScopeKey;
  const cache = new OverlaySnapshotCache();
  cache.update(scope, { schemaVersion: 1, revision: 1, state });
  const calls: unknown[] = [];
  const overlay = new TodoOverlay(cache, () => scope);
  overlay.setUICtx({ setWidget: (_key, value) => calls.push(value) });

  overlay.update();
  assert.equal(overlay.isRegistered(), true);
  overlay.setSuspended(true);
  assert.equal(overlay.isRegistered(), false);
  assert.equal(calls.at(-1), undefined);
  overlay.setSuspended(false);
  assert.equal(overlay.isRegistered(), true);
  assert.equal(typeof calls.at(-1), "function");
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
