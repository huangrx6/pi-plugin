import { sanitizeTerminalText } from "./format.ts";
import type { Op } from "./reducer.ts";
import type { Task, TaskMutationParams, TaskState, TodoDetails } from "./types.ts";

const DEFAULT_VISIBLE_CREATED = 6;
const DEFAULT_VISIBLE_OPEN = 6;

function taskLabel(task: Task): string {
 return `#${task.id} ${sanitizeTerminalText(task.subject)}`;
}

export function formatCreationNotice(
 params: TaskMutationParams,
 details: TodoDetails | undefined,
 toolText: string,
 limit = DEFAULT_VISIBLE_CREATED,
): string | undefined {
 if (!details || !toolText.startsWith("Created")) return undefined;
 const count =
  params.action === "create"
   ? 1
   : params.action === "createMany" && Array.isArray(params.items)
     ? params.items.length
     : 0;
 if (!count) return undefined;
 const firstId = details.nextId - count;
 const created = details.tasks
  .filter((task) => task.id >= firstId && task.id < details.nextId)
  .sort((a, b) => a.id - b.id);
 if (!created.length) return undefined;
 const shown = created.slice(0, Math.max(1, limit));
 const lines = [
  `已创建 ${created.length} 个任务`,
  ...shown.map((task) => `  ${taskLabel(task)}`),
 ];
 if (created.length > shown.length)
  lines.push(`  另有 ${created.length - shown.length} 项 · /todos`);
 return lines.join("\n");
}

/** Remind the model about earlier open work immediately after completion. */
export function appendOpenTaskReminder(
 text: string,
 op: Op,
 state: TaskState,
 limit = DEFAULT_VISIBLE_OPEN,
): string {
 const completed =
  (op.kind === "finish" && op.changed !== false) ||
  (op.kind === "update" && op.fromStatus !== op.toStatus && op.toStatus === "completed");
 if (!completed) return text;
 const open = state.tasks.filter(
  (task) =>
   task.archivedAt === undefined &&
   task.closedAt === undefined &&
   (task.status === "pending" || task.status === "in_progress"),
 );
 if (!open.length) return text;
 const shown = open.slice(0, Math.max(1, limit)).map(taskLabel);
 const suffix = open.length > shown.length ? `, +${open.length - shown.length} more` : "";
 return `${text}\nStill open—reconcile before the final response: ${shown.join(", ")}${suffix}`;
}
