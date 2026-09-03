/**
 * read-model.ts — pure read helpers bridging domain (graph.ts) to
 * presentation (format.ts). NOT in projection.ts (FROZEN). B3 and
 * B4 both consume this; do not duplicate the logic at call sites.
 *
 * Module invariants:
 *   1. PURE READ: no state mutation, no clock, no pi imports.
 *   2. Reads from graph.ts (unsatisfiedDependencies, brokenDependencies)
 *      as primitives — never reimplements dep classification.
 *   3. Walks task.blockedBy in ORIGINAL declaration order so the row
 *      renders `#99? #18` (declaration order) NOT `#18 #99?`
 *      (graph-iteration order).
 *   4. Excludes completed deps — they're satisfied and shouldn't show
 *      in the row suffix.
 */

import { brokenDependencies, unsatisfiedDependencies } from "./graph.ts";
import type { TaskDependencyPresentation, TaskState } from "./types.ts";

/**
 * Build formatter-ready dependency presentation for a task.
 *
 * Iterates task.blockedBy in declaration order. Each entry becomes:
 *   - pending / in_progress → { id, kind: "waiting" }
 *   - missing                → { id, kind: "missing" }
 *   - deleted                → { id, kind: "deleted" }
 *   - completed              → omitted (satisfied; not rendered)
 *
 * If taskId is not in state, returns [].
 *
 * @example
 *   // state: #17 completed; #18 in_progress; #99 missing
 *   // task: #20 blockedBy [99, 18, 17]
 *   buildDependencyPresentation(state, 20)
 *   // → [
 *   //     { id: 99, kind: "missing" },
 *   //     { id: 18, kind: "waiting" },
 *   //   ]
 *   // (declaration order preserved; #17 completed omitted)
 */
export function buildDependencyPresentation(
 state: TaskState,
 taskId: number,
): TaskDependencyPresentation[] {
 const task = state.tasks.find((t) => t.id === taskId);
 if (!task?.blockedBy?.length) return [];

 // Pre-compute id → kind maps from graph primitives (single source).
 const waiting = new Set(
  unsatisfiedDependencies(state, taskId).map((d) => d.id),
 );
 const broken = new Map<number, "missing" | "deleted">();
 for (const b of brokenDependencies(state, taskId)) {
  broken.set(b.id, b.reason);
 }

 // Walk the original blockedBy order so the row renders in
 // declaration order, not graph-iteration order.
 const out: TaskDependencyPresentation[] = [];
 for (const depId of task.blockedBy) {
  if (waiting.has(depId)) {
   out.push({ id: depId, kind: "waiting" });
  } else if (broken.has(depId)) {
   const reason = broken.get(depId);
   if (reason !== undefined) {
    out.push({ id: depId, kind: reason });
   }
  }
  // Completed deps: skip (satisfied, no need to render).
 }
 return out;
}
