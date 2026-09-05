import { projectActiveView, projectArchived, projectCompleted } from "./projection.ts";
import type { TaskState } from "./types.ts";

/** Actions follow the same canonical projections used by command validation. */
export function taskActions(state: TaskState, id: number): string[] {
  const view = projectActiveView(state);
  if (projectArchived(state).some(task => task.id === id)) return ["restore — 恢复到任务列表", "detail — 查看详情"];
  if (projectCompleted(state).some(task => task.id === id)) return ["reopen — 重新打开", "archive — 归档", "detail — 查看详情"];
  const actions = view.running.some(task => task.id === id) ? ["finish — 标记完成"]
    : view.ready.some(task => task.id === id) ? ["start — 开始任务"] : [];
  return [...actions, "detail — 说明、阻塞原因与后续任务", "edit — 修改任务名称"];
}
