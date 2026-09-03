/**
 * graph.ts — pure task-graph semantics.
 *
 * Module invariants:
 *   1. Graph semantics NEVER depend on `archivedAt`. Archive is
 *      visibility; graph integrity is unaffected.
 *   2. Pure read-only: no state mutation, no clock access, no pi
 *      runtime imports.
 *   3. For structurally valid input, graph query functions NEVER
 *      throw for graph-content anomalies (missing nodes, deleted
 *      nodes, empty deps, cycles in legacy state).
 *   4. graph.ts NEVER references projection-layer concepts:
 *      READY, BLOCKED, RUNNING, visible, overlay, section.
 *   5. blockedBy MUST contain unique task ids (domain invariant).
 *      Reducer normalizes via dedupeBlockedBy on write (P0-A2);
 *      graph functions assume uniqueness.
 *
 * Runtime input validation is owned by upstream boundaries (tool
 * schema, CLI parser, replay normalization). graph.ts is not a JSON
 * validator — TypeScript types are erased at runtime.
 */

import type {
 BrokenDependency,
 BrokenDependencyRef,
 CompletionImpact,
 Task,
 TaskState,
 WhyBlockedResult,
} from "./types.ts";

// ── Internal helpers ────────────────────────────────────────────────────

function getTask(state: TaskState, id: number): Task | undefined {
 return state.tasks.find((t) => t.id === id);
}

/**
 * BFS closure of `taskId` over `unsatisfiedDependencies` edges.
 * Yields taskId + every live blocker reachable via unsatisfied chains,
 * deduplicated, in BFS discovery order. Broken deps are dead ends for
 * the walk (surfaced separately via the broken aggregation).
 */
function blockerClosure(state: TaskState, taskId: number): Task[] {
 const start = getTask(state, taskId);
 if (!start) return [];
 const seen = new Set<number>([taskId]);
 const closure: Task[] = [start];
 const queue: Task[] = [...unsatisfiedDependencies(state, taskId)];
 while (queue.length > 0) {
  const cur = queue.shift() as Task;
  if (seen.has(cur.id)) continue;
  seen.add(cur.id);
  closure.push(cur);
  queue.push(...unsatisfiedDependencies(state, cur.id));
 }
 return closure;
}

/**
 * DFS for wouldCreateCycle: walks RAW edge ids (not resolved Tasks)
 * so dangling references can close a cycle that resolved traversal
 * would miss. Returns true iff `fromId` can reach `targetId` via
 * existing blockedBy edges.
 */
function rawReaches(
 state: TaskState,
 fromId: number,
 targetId: number,
 visited: Set<number>,
): boolean {
 if (fromId === targetId) return true;
 if (visited.has(fromId)) return false;
 visited.add(fromId);
 const from = getTask(state, fromId);
 if (!from?.blockedBy?.length) return false;
 for (const depId of from.blockedBy) {
  if (rawReaches(state, depId, targetId, visited)) return true;
 }
 return false;
}

// ── Exported graph functions ────────────────────────────────────────────

/**
 * All tasks referenced in `taskId.blockedBy` that exist in state.
 * Excludes missing ids (those are "broken", surfaced via
 * brokenDependencies). Includes tasks of any status (pending /
 * in_progress / completed / deleted) — graph layer is status-agnostic
 * except where explicitly partitioned.
 * Order = insertion order of blockedBy.
 * taskId missing OR taskId has no blockedBy → [].
 */
export function directDependencies(state: TaskState, taskId: number): Task[] {
 const t = getTask(state, taskId);
 if (!t?.blockedBy?.length) return [];
 const out: Task[] = [];
 for (const depId of t.blockedBy) {
  const dep = getTask(state, depId);
  if (dep) out.push(dep);
 }
 return out;
}

/**
 * Tasks whose `blockedBy` array contains `taskId` — in insertion order.
 * target does NOT need to exist; this is the reverse INDEX over raw ids.
 * Includes deleted tombstones (lineage preserved). Does NOT filter by
 * archivedAt (graph layer doesn't see archivedAt).
 */
export function reverseDependencies(state: TaskState, taskId: number): Task[] {
 return state.tasks.filter((t) => t.blockedBy?.includes(taskId) === true);
}

/**
 * Structurally invalid dependency references in `taskId.blockedBy`:
 *   - "missing": id not present in state.tasks
 *   - "deleted": id present but status === "deleted"
 * pending / in_progress are valid graph nodes and therefore NOT broken.
 * Local to taskId only — chain aggregation happens in whyBlocked.
 * Order = insertion order of blockedBy.
 */
export function brokenDependencies(
 state: TaskState,
 taskId: number,
): BrokenDependency[] {
 const t = getTask(state, taskId);
 if (!t?.blockedBy?.length) return [];
 const out: BrokenDependency[] = [];
 for (const depId of t.blockedBy) {
  const dep = getTask(state, depId);
  if (!dep) {
   out.push({ id: depId, reason: "missing" });
  } else if (dep.status === "deleted") {
   out.push({ id: depId, reason: "deleted" });
  }
 }
 return out;
}

/**
 * Direct deps whose status ∈ {pending, in_progress}.
 * Excludes deleted (deleted is "broken", not "unsatisfied" — partition).
 * Excludes missing (missing is "broken" — not in state.tasks).
 * Order = insertion order of blockedBy.
 */
export function unsatisfiedDependencies(
 state: TaskState,
 taskId: number,
): Task[] {
 const t = getTask(state, taskId);
 if (!t?.blockedBy?.length) return [];
 const out: Task[] = [];
 for (const depId of t.blockedBy) {
  const dep = getTask(state, depId);
  if (dep && (dep.status === "pending" || dep.status === "in_progress")) {
   out.push(dep);
  }
 }
 return out;
}

/**
 * True iff:
 *   - taskId exists in state
 *   - every blockedBy id is present in state AND status === "completed"
 * Returns false defensively if taskId not found.
 * Vacuous true (no blockedBy) returns true.
 */
export function dependenciesSatisfied(
 state: TaskState,
 taskId: number,
): boolean {
 const t = getTask(state, taskId);
 if (!t) return false;
 if (!t.blockedBy?.length) return true;
 return t.blockedBy.every((depId) => {
  const dep = getTask(state, depId);
  return dep?.status === "completed";
 });
}

/**
 * True iff adding edges `taskId → depId` for every depId ∈ nextBlockedBy
 * creates a directed cycle in the dependency graph.
 *
 * Cycle condition: ∃ depId ∈ nextBlockedBy such that walking forward
 * from `depId` through existing dependency edges (raw blockedBy ids,
 * not just resolved Tasks) eventually reaches `taskId`.
 *
 * Self-loop: depId === taskId → true.
 * nextBlockedBy is the FINAL list (post-merge), not a diff.
 * taskId need not exist in state.
 */
export function wouldCreateCycle(
 state: TaskState,
 taskId: number,
 nextBlockedBy: number[],
): boolean {
 for (const depId of nextBlockedBy) {
  if (depId === taskId) return true;
  if (rawReaches(state, depId, taskId, new Set())) return true;
 }
 return false;
}

/**
 * Structured explanation of why taskId cannot run.
 *
 * direct: unsatisfiedDependencies(state, taskId).
 *
 * roots: derived from the blocker closure — tasks with no unsatisfied
 *   direct dep. Original taskId excluded.
 *
 * broken: aggregated across the entire blocker closure (NOT just
 *   taskId's local brokenDeps). Each entry identifies which task
 *   holds which bad reference.
 *
 * Legacy cyclic graphs:
 *   Traversal terminates via the `seen` set.
 *   A cyclic blocker component (e.g. #1 ↔ #2) may yield EMPTY `roots`:
 *   every node in the cycle has at least one unsatisfied direct dep
 *   within the cycle, so the root predicate is never satisfied.
 *   Caller can detect via direct.length > 0 ∧ roots.length === 0
 *                            ∧ broken.length === 0.
 *   This is diagnostic legacy behavior; reducer prevents NEW cycles
 *   from being created via wouldCreateCycle.
 */
export function whyBlocked(state: TaskState, taskId: number): WhyBlockedResult {
 const start = getTask(state, taskId);
 if (!start) return { direct: [], roots: [], broken: [] };

 const direct = unsatisfiedDependencies(state, taskId);
 const closure = blockerClosure(state, taskId);
 const roots = closure
  .filter((t) => t.id !== taskId)
  .filter((t) => unsatisfiedDependencies(state, t.id).length === 0);

 const broken: BrokenDependencyRef[] = closure.flatMap((t) =>
  brokenDependencies(state, t.id).map((b) => ({
   taskId: t.id,
   dependencyId: b.id,
   reason: b.reason,
  })),
 );

 return { direct, roots, broken };
}

/**
 * Hypothetical graph impact if `taskId` were moved to "completed"
 * (without mutating state).
 *
 * taskId state gate:
 *   - pending or in_progress → simulate
 *   - completed / deleted / missing → {newlySatisfied:[], downstream:[]}
 *
 * downstream: BFS over reverseDependencies, excluding deleted
 *   tombstones (graph dead end). Does NOT filter by archivedAt
 *   (graph layer never sees archivedAt). Insertion-order preserving,
 *   deduplicated. Includes newlySatisfied.
 *
 * newlySatisfied: subset of downstream where
 *   - status === "pending"
 *   - taskId ∈ blockedBy
 *   - all OTHER blockedBy ids are present AND status === "completed"
 */
export function affectedByCompletion(
 state: TaskState,
 taskId: number,
): CompletionImpact {
 const t = getTask(state, taskId);
 if (!t || t.status === "completed" || t.status === "deleted") {
  return { newlySatisfied: [], downstream: [] };
 }

 // BFS over reverse deps, excluding deleted (graph dead end).
 const seen = new Set<number>();
 const downstream: Task[] = [];
 const queue: Task[] = reverseDependencies(state, taskId).filter(
  (d) => d.status !== "deleted",
 );
 while (queue.length > 0) {
  const cur = queue.shift() as Task;
  if (seen.has(cur.id)) continue;
  seen.add(cur.id);
  downstream.push(cur);
  const next = reverseDependencies(state, cur.id).filter(
   (d) => d.status !== "deleted",
  );
  queue.push(...next);
 }

 const newlySatisfied = downstream.filter((d) => {
  if (d.status !== "pending") return false;
  if (!d.blockedBy?.includes(taskId)) return false;
  return d.blockedBy.every((depId) => {
   if (depId === taskId) return true;
   const dep = getTask(state, depId);
   return dep?.status === "completed";
  });
 });

 return { newlySatisfied, downstream };
}
