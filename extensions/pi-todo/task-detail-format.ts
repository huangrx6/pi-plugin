/**
 * task-detail-format.ts — P4-C2 (rich `/todos <id>` formatter).
 *
 * Composes the frozen P2-A classification (`queryWhyTask`) and P2-B
 * formatting (`formatWhyTask`) with two P4-owned additions: the
 * `Task.description` presentation line and the direct-unlock
 * presentation block.
 *
 * Layer chain:
 *   queryWhyTask (P2-A) → formatWhyTask (P2-B) → task-detail-format (P4-C2)
 *   + queryUnlocksTask (P2-A) → formatDirectUnlockConsequences (P4-D)
 *   + raw Task.description (presentation-only lookup)
 *
 * Module invariants (P4-C2 LOCK 18, 19, 20, 25, 26, 28 + P4-D D3):
 *   1. `queryWhyTask` is the SOLE classification authority
 *      (not-found / deleted / archived / completed / ready / running /
 *      blocked). The formatter does NOT inspect `task.status`,
 *      `task.archivedAt`, `task.blockedBy` for semantic decisions
 *      (C18, C28).
 *   2. The frozen `formatWhyTask` is the canonical semantic body:
 *      primary task row, blocker section wording, blocker markers
 *      (`?` / `†`). P4 does NOT reconstruct or partially duplicate
 *      this (C25, C26).
 *   3. Raw `Task` lookup is permitted ONLY to read `description`
 *      (a presentation-data field). It is FORBIDDEN to read
 *      `status`, `archivedAt`, `blockedBy` or any other
 *      lifecycle / readiness / dependency field. This is a
 *      machine-verifiable contract (C28).
 *   4. No "Required by:" section. No reverse-dependency inspection
 *      (C19).
 *   5. No second Status / State vocabulary. The canonical task
 *      presentation (the row itself) is the user's role/lifecycle
 *      representation (C20).
 *   6. Direct unlocks only via frozen `queryUnlocksTask` +
 *      `formatDirectUnlockConsequences` (P4-D composition). No
 *      transitive traversal (C9). The composition is typed-result
 *      based — it consumes `UnlocksTaskResult` discriminated union,
 *      NOT formatter string[]. See LOCK D3.
 *   7. Active classifications (`ready` / `running` / `blocked`) get
 *      the unlock presentation appended. `completed` / `archived`
 *      / `not-found` do not (they have no completion consequence).
 *   8. LOCK D3: this module does NOT structurally parse, slice,
 *      index, regex-match, or otherwise decompose `string[]` output
 *      from any frozen P0–P3 formatter. The unlocks subsection is
 *      composed from the typed result via `formatDirectUnlockConsequences`.
 */

import { visibleWidth } from "./format.ts";
import { queryUnlocksTask, queryWhyTask } from "./graph-query.ts";
import { formatWhyTask } from "./graph-format.ts";
import { formatDirectUnlockConsequences } from "./direct-unlock-format.ts";
import type { TaskState } from "./types.ts";

/**
 * Presentation-only raw Task lookup. This is the ONLY place in
 * P4-C2 that touches raw `Task`, and it restricts itself to
 * `.id` + `.description` (LOCK 28). All lifecycle / readiness /
 * dependency decisions are delegated to `queryWhyTask` (P2-A).
 */
function lookupDescription(state: TaskState, id: number): string {
 // SAFETY: only `task.description` is read here. The compile-time
 // type of `Task.description` is `string | undefined`; we narrow to
 // empty-string when absent. No other Task field is touched.
 for (const task of state.tasks) {
  if (task.id === id) {
   return task.description ?? "";
  }
 }
 return "";
}

/**
 * Word-wrap a string to the given width using the frozen
 * `visibleWidth` primitive. Preserves word boundaries. Words wider
 * than `width` are hard-broken to fit. Empty input → `[""]`.
 */
function wrapText(text: string, width: number): string[] {
 if (width <= 0) return [text];
 const result: string[] = [];
 const words = text.split(/\s+/).filter((w) => w.length > 0);
 if (words.length === 0) return [""];
 let current = "";
 for (const word of words) {
  if (current === "") {
   current = word;
  } else if (visibleWidth(current + " " + word) <= width) {
   current = current + " " + word;
  } else {
   result.push(current);
   current = word;
  }
 }
 if (current !== "") result.push(current);
 return result;
}

export function formatTaskDetailRich(
 state: TaskState,
 id: number,
 width: number,
): string[] {
 // P2-A: sole classification authority (LOCK 18).
 const why = queryWhyTask(state, id);

 // not-found: return the frozen canonical output verbatim (LOCK 25).
 if (why.kind === "not-found") {
  return formatWhyTask(why, width);
 }

 // P2-B: canonical semantic body — primary row, blocker section,
 // blocker markers. Embed verbatim (LOCK 25, 26).
 const semanticBody = formatWhyTask(why, width);

 // P4-only addition: surface `Task.description` (presentation data
 // field, LOCK 28). NOT lifecycle / readiness / dependency data.
 const description = lookupDescription(state, id);
 const descriptionBlock =
  description === "" ? [] : ["", ...wrapText(description, width)];

 // P4-only addition: direct unlocks for active classifications only.
 // LOCK D3: composed from the frozen `UnlocksTaskResult` typed
 // discriminated union via `formatDirectUnlockConsequences`. The P4
 // composition is a fresh terminal presentation; it does not
 // decompose, slice, or otherwise re-parse any frozen formatter
 // string[]. completed / archived have no completion consequence to
 // surface; not-found handled above (early return).
 let unlockBlock: string[] = [];
 if (why.kind === "ready" || why.kind === "running" || why.kind === "blocked") {
  const unlocks = queryUnlocksTask(state, id);
  const consequences = formatDirectUnlockConsequences(unlocks, width);
  if (consequences.length > 0) {
   unlockBlock = ["", ...consequences];
  }
 }

 return [...semanticBody, ...descriptionBlock, ...unlockBlock];
}
