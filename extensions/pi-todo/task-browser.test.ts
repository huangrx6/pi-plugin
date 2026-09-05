import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "./format.ts";
import {
  TaskBrowserComponent,
  type TaskBrowserIntent,
  type TaskBrowserSession,
} from "./task-browser.ts";
import type { TaskState } from "./types.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};
const bindings = {
  matches(data: string, id: string): boolean {
    const map: Record<string, string> = {
      up: "tui.select.up",
      down: "tui.select.down",
      enter: "tui.select.confirm",
      escape: "tui.select.cancel",
      pageUp: "tui.select.pageUp",
      pageDown: "tui.select.pageDown",
      home: "tui.editor.cursorLineStart",
      end: "tui.editor.cursorLineEnd",
      backspace: "tui.editor.deleteCharBackward",
    };
    return map[data] === id;
  },
};

function manyTasks(count: number): TaskState {
  return {
    nextId: count + 1,
    tasks: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      subject: `任务 ${index + 1}`,
      status: index === 0 ? "in_progress" as const : "pending" as const,
      createdAt: index,
      updatedAt: index,
    })),
  };
}

function build(
  state: TaskState,
  session: TaskBrowserSession,
  onDone: (intent: TaskBrowserIntent) => void = () => {},
  rows = 24,
): TaskBrowserComponent {
  return new TaskBrowserComponent(
    { terminal: { rows }, requestRender: () => {} },
    theme,
    bindings,
    state,
    session,
    onDone,
  );
}

test("large task lists stay inside the terminal and keep the selection visible", () => {
  const state = manyTasks(100);
  const session: TaskBrowserSession = { view: "current", query: "" };
  const browser = build(state, session, undefined, 24);

  browser.handleInput("end");
  const lines = browser.render(72);

  assert.ok(lines.length <= Math.floor(24 * 0.82));
  assert.ok(lines.some((line) => line.includes("#100")));
  assert.ok(lines.some((line) => line.includes("100/100")));
  assert.ok(lines.every((line) => visibleWidth(line) === 72));
});

test("the task window paints every cell with the extension surface background", () => {
  const state = manyTasks(2);
  const session: TaskBrowserSession = { view: "current", query: "" };
  const backgrounds: string[] = [];
  const browser = new TaskBrowserComponent(
    { terminal: { rows: 24 }, requestRender: () => {} },
    {
      fg: (_color, text) => text,
      bg: (color, text) => {
        backgrounds.push(color);
        return text;
      },
    },
    bindings,
    state,
    session,
    () => {},
  );

  const lines = browser.render(72);
  assert.equal(backgrounds.length, lines.length);
  assert.deepEqual(new Set(backgrounds), new Set(["customMessageBg"]));
});

test("search filters in place and never renders terminal control payloads", () => {
  const state = manyTasks(20);
  state.tasks[14]!.subject = "发布\x1b]9;fake\x07检查";
  const session: TaskBrowserSession = { view: "all", query: "" };
  const browser = build(state, session);

  browser.handleInput("/");
  browser.handleInput("#15");
  browser.handleInput("enter");
  const lines = browser.render(64);

  assert.ok(lines.some((line) => line.includes("#15")));
  assert.ok(!lines.join("\n").includes("fake"));
  assert.ok(!lines.join("\n").includes("\x1b]"));
});

test("detail actions and task creation return structured intents", () => {
  const state = manyTasks(2);
  const intents: TaskBrowserIntent[] = [];
  const session: TaskBrowserSession = { view: "current", query: "", selectedId: 1 };
  const detail = build(state, session, (intent) => intents.push(intent));

  detail.handleInput("enter");
  assert.ok(detail.render(72).some((line) => line.includes("标记完成")));
  // 0.10.0：动作序列头部是 continue，下移一项选中 finish。
  detail.handleInput("down");
  detail.handleInput("enter");
  assert.deepEqual(intents[0], { kind: "action", action: "finish", id: 1 });

  const createSession: TaskBrowserSession = { view: "current", query: "" };
  const create = build(state, createSession, (intent) => intents.push(intent));
  create.handleInput("n");
  create.handleInput("补充回归测试");
  create.handleInput("enter");
  assert.deepEqual(intents[1], { kind: "create", subject: "补充回归测试" });
});

test("completed, archived and all are first-class views", () => {
  const state: TaskState = {
    nextId: 4,
    tasks: [
      { id: 1, subject: "当前", status: "pending", createdAt: 1, updatedAt: 1 },
      { id: 2, subject: "完成", status: "completed", createdAt: 2, updatedAt: 2 },
      { id: 3, subject: "归档", status: "completed", archivedAt: 3, createdAt: 3, updatedAt: 3 },
    ],
  };
  const session: TaskBrowserSession = { view: "completed", query: "" };
  const browser = build(state, session);
  assert.ok(browser.render(72).some((line) => line.includes("#2")));
  assert.ok(!browser.render(72).some((line) => line.includes("#3 归档")));

  browser.handleInput("\t");
  assert.equal(session.view, "archived");
  assert.ok(browser.render(72).some((line) => line.includes("#3")));

  browser.handleInput("\t");
  assert.equal(session.view, "all");
  const all = browser.render(72).join("\n");
  assert.match(all, /#1/);
  assert.match(all, /#2/);
  assert.match(all, /#3/);
});
