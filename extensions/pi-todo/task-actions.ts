import { projectActiveView, projectArchived, projectCompleted } from "./projection.ts";
import type { TaskState } from "./types.ts";

/** Actions follow the same canonical projections used by command validation. */
export function taskActions(state: TaskState, id: number): string[] {
 const view = projectActiveView(state);
 const task = state.tasks.find((candidate) => candidate.id === id);
 if (task?.closedAt !== undefined) return ["reopen — 重新打开", "detail — 查看详情", "edit — 修改任务名称"];
 if (projectArchived(state).some(task => task.id === id)) return ["restore — 恢复到任务列表", "detail — 查看详情"];
 if (projectCompleted(state).some(task => task.id === id)) return ["reopen — 重新打开", "archive — 归档", "detail — 查看详情"];
 const actions = view.running.some(task => task.id === id)
  ? ["continue — 继续任务", "finish — 标记完成"]
  : view.ready.some(task => task.id === id)
    ? ["start — 开始任务"]
    : [];
 // Every unfinished active task can be explicitly ended or reviewed. The
 // task may be pending because it was never started, or it may be blocked by
 // another task; both cases still need a deliberate close/review path.
 if (task?.status === "pending" || task?.status === "in_progress") {
  actions.push("close — 结束任务", "review — 让模型判断");
 }
 return [...actions, "detail — 说明、阻塞原因与后续任务", "edit — 修改任务名称"];
}
