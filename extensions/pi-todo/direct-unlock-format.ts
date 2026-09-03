/**
 * direct-unlock-format.ts — P4-D (direct-consequence subsection).
 *
 * Composes the "Completing this task would make ready" subsection from
 * the frozen P2-A `UnlocksTaskResult` typed discriminated union. Does
 * NOT parse, slice, or otherwise structurally decompose the output of
 * any frozen P0–P3 formatter (LOCK D3).
 *
 * Layer chain:
 *   UnlocksTaskResult (P2-A typed result) → direct-unlock-format (P4-D)
 *   → formatTaskRow (P0-B public row primitive)
 *
 * Module invariants (P4-D LOCK D3):
 *   1. Input is the frozen `UnlocksTaskResult` discriminated union,
 *      not `string[]` from any formatter. No structural parsing of
 *      frozen formatter output.
 *   2. Exhaustively switch on `result.kind`. No incidental `.kind`
 *      introspection; the switch is the contract.
 *   3. Re-render only using the public P0-B `formatTaskRow` primitive
 *      (with a synthetic `Task` shape derived from `TaskPresentation`).
 *      The frozen `formatUnlocksTask` is NOT called.
 *   4. The "Completing this task would make ready" header is the only
 *      presentation phrase owned by this module. If the phrase changes
 *      in a future iteration, this file is the single point of
 *      update — no structural decomposition to update.
 *   5. Re-derives NO dependency / readiness / affectedByCompletion
 *      semantic. The frozen P2-A query already produced the right set
 *      of unlocks; we only restate it as presentation.
 */

import { formatTaskRow } from "./format.ts";
import type { TaskPresentation, UnlocksTaskResult } from "./graph-query.ts";
import type { Task } from "./types.ts";

const UNLOCKS_HEADER = "Completing this task would make ready:";
const INDENT = "  ";

/**
 * Render the direct-consequence subsection for a single task.
 *
 * Returns:
 *   - `[]` when the task has no completion consequence to surface
 *     (not-found / completed / archived / unlocks with empty array)
 *   - `[UNLOCKS_HEADER, ...indented rows]` otherwise
 *
 * The P4-D architecture intentionally does NOT include the primary
 * task row in this output. Callers that want a complete rich-detail
 * view embed the frozen `formatWhyTask` body (which already emits
 * the row) and append this subsection afterward.
 */
export function formatDirectUnlockConsequences(
 result: UnlocksTaskResult,
 width: number,
): string[] {
 switch (result.kind) {
  case "not-found":
  case "completed":
  case "archived":
   // No completion consequence for these classifications.
   return [];
  case "unlocks": {
   if (result.unlocks.length === 0) {
    return [];
   }
   const lines: string[] = [UNLOCKS_HEADER];
   const rowWidth = Math.max(1, width - INDENT.length);
   for (const t of result.unlocks) {
    lines.push(
     INDENT +
      formatTaskRow(toSyntheticTask(t), {
       role: t.role,
       width: rowWidth,
      }),
    );
   }
   return lines;
  }
  default: {
   // Exhaustiveness: any new UnlocksTaskResult kind added in P2-A
   // is caught at compile time here. Frozen P2-A owns the union shape;
   // P4-D must keep up.
   const _exhaustive: never = result;
   void _exhaustive;
   return [];
  }
 }
}

/**
 * Synthesize a minimal `Task` shape from a `TaskPresentation` so we
 * can use the public P0-B `formatTaskRow` primitive. `formatTaskRow`
 * only reads `.id` and `.subject` for the row itself; `.blockedBy`
 * and `.archivedAt` are only consulted when a `dependencies` ctx is
 * passed — which we do NOT pass here. The other Task fields
 * (`status` / `createdAt` / `updatedAt`) are unused by the row
 * formatter and are populated with safe defaults.
 */
function toSyntheticTask(t: TaskPresentation): Task {
 return {
  id: t.id,
  subject: t.subject,
  status: "pending",
  createdAt: 0,
  updatedAt: 0,
 };
}
