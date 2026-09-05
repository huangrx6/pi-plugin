/**
 * Domain types + the tool parameter schema. No runtime pi imports —
 * only type imports, so the extension loads with zero module resolution
 * beyond its own files.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/** Canonical task id (P1-A introduces this alias). All P1 mutation APIs
 *  use this type. Task.id remains `number` on the runtime model; this
 *  alias exists for type-level clarity in mutation references and to
 *  provide a single migration point if the id domain ever changes. */
export type TaskId = number;

export type TaskAction =
 | "create"
 | "update"
 | "list"
 | "get"
 | "delete"
 | "clear"
 | "start"
 | "finish"
 | "reopen"
 | "close"
 | "archive"
 | "restore";

export interface Task {
 id: number;
 subject: string;
 description?: string;
 /** Present-continuous label shown while in_progress ("writing tests"). */
 activeForm?: string;
 status: TaskStatus;
 /** Ids this task is blocked by (insertion order preserved). */
 blockedBy?: number[];
 owner?: string;
 metadata?: Record<string, unknown>;
 /** Monotonic domain timestamp of task creation. Set by reducer via
  *  ctx.now(). Never changes after create. Legacy/missing → 0 via
  *  normalizeTask. */
 createdAt: number;
 /** Timestamp of last successful state change. Bumped only on REAL
  *  changes — no-op updates leave it untouched (atomicity rule).
  *  Set by reducer via ctx.now(). */
 updatedAt: number;
 /** Timestamp when task was archived (visibility off). undefined =
  *  visible. Orthogonal to status — archive is visibility, not lifecycle.
  *  Managed by reducer in A2.4; declared here as data shape. */
 archivedAt?: number;
 /** Timestamp when an unfinished task was intentionally ended. */
 closedAt?: number;
 /** Optional explanation recorded for an intentional close. */
 closedReason?: string;
}

/** Canonical state per session. `nextId` is MONOTONIC — see reducer. */
export interface TaskState {
 tasks: Task[];
 nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/**
 * Persistence payload attached to every successful toolResult.
 * Replay (`store.ts`) reconstructs state from the LAST entry on the
 * branch carrying this shape — which is exactly how the list survives
 * /reload and compaction (sessions are append-only; branch entries are
 * never dropped by compaction summaries).
 *
 * `schemaVersion` is OPTIONAL on the wire for backward compatibility
 * with pre-A2 snapshots. v1 = current shape (timestamps populated by
 * reducer). Missing or !== 1 → legacy path: per-task normalization via
 * normalizeTask in replayFromBranch.
 */
export interface TodoDetails {
 schemaVersion?: number;
 tasks: Task[];
 nextId: number;
}

/** Structural check for replay: is this details payload ours?
 *  Permissive on schemaVersion — see TodoDetails doc. */
export function isTodoDetails(value: unknown): value is TodoDetails {
 if (!value || typeof value !== "object") return false;
 const v = value as Record<string, unknown>;
 return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Per-task migration seam for legacy / untrusted snapshots.
 *
 * Defaults applied:
 *   - createdAt missing → 0
 *   - updatedAt missing → = createdAt
 *   - archivedAt missing → undefined (visible)
 *   - closedAt / closedReason missing → undefined (not ended)
 *   - subject missing → "" (caller decides whether to reject)
 *   - status missing → "pending" (caller decides whether to reject)
 *
 * Caller is responsible for validating required fields beyond id
 * (subject, status). normalizeTask fills in ONLY timestamp defaults
 * and is the single place where legacy → v1 shape conversion happens.
 * Used by store.ts replayFromBranch for legacy snapshots.
 */
export function normalizeTask(raw: Partial<Task> & { id: number }): Task {
 const createdAt = raw.createdAt ?? 0;
 return {
  ...raw,
  id: raw.id,
  subject: raw.subject ?? "",
  status: raw.status ?? "pending",
  createdAt,
  updatedAt: raw.updatedAt ?? createdAt,
 };
}

// ── Reduce context (P0-A2.1) ────────────────────────────────────────────

/**
 * Context passed to applyTaskMutation. Forces reducer to be deterministic
 * by injecting the clock; tests use a fixed now() to verify timestamps
 * without time-of-day dependencies.
 *
 * Production call site (index.ts): { now: () => Date.now() }
 * Tests: { now: () => 12345 } or { now: () => ++counter }
 */
export interface ReduceContext {
 /** Returns current time in milliseconds (or any monotonic domain).
  *  Reducer uses this for ALL createdAt/updatedAt writes. */
 now: () => number;
}

// ── Mutation errors (P0-A2.2) ────────────────────────────────────────────

/** Discriminator codes for structured reducer errors. Consumers (CLI
 *  formatter, Tool API) can pattern-match without parsing strings.
 *  Adding a new error path means adding a code here + a variant below
 *  + a formatContent case + (usually) a test in reducer.test.ts. */
export type MutationErrorCode =
 | "SUBJECT_REQUIRED"
 | "ID_REQUIRED"
 | "TASK_NOT_FOUND"
 | "DEPENDENCY_NOT_FOUND"
 | "DEPENDENCY_DELETED"
 | "DEPENDENCY_SELF"
 | "DEPENDENCY_CYCLE"
 | "INVALID_TRANSITION"
 | "TOMBSTONE_IMMUTABLE"
 | "ALREADY_DELETED"
 | "ALREADY_ARCHIVED"
 | "NOT_ARCHIVED"
 | "ARCHIVE_REQUIRES_COMPLETED"
 | "ALREADY_CLOSED"
 | "CLOSE_REQUIRES_ACTIVE"
 | "TASK_REFERENCED"
 | "MUTABLE_FIELDS_REQUIRED"
 | "UNKNOWN_ACTION";

/** Structured error returned by applyTaskMutation on rejected mutations.
 *  `code` is the primary dispatch key; remaining fields are contextual
 *  payload. Consumers should pattern-match on `code` for behavior and
 *  use context fields for messages / debugging. */
export type MutationError =
 | { code: "SUBJECT_REQUIRED" }
 | { code: "ID_REQUIRED" }
 | { code: "TASK_NOT_FOUND"; id: number }
 | { code: "DEPENDENCY_NOT_FOUND"; depId: number }
 | { code: "DEPENDENCY_DELETED"; depId: number }
 | { code: "DEPENDENCY_SELF"; depId: number }
 | { code: "DEPENDENCY_CYCLE"; attempted: number[] }
 | {
    code: "INVALID_TRANSITION";
    from: TaskStatus;
    to: TaskStatus;
   }
 | { code: "TOMBSTONE_IMMUTABLE"; id: number }
 | { code: "ALREADY_DELETED"; id: number }
 | { code: "ALREADY_ARCHIVED"; id: number }
 | { code: "NOT_ARCHIVED"; id: number }
 | { code: "ARCHIVE_REQUIRES_COMPLETED"; id: number }
 | { code: "ALREADY_CLOSED"; id: number }
 | { code: "CLOSE_REQUIRES_ACTIVE"; id: number }
 | { code: "TASK_REFERENCED"; id: number; referencedBy: number[] }
 | { code: "MUTABLE_FIELDS_REQUIRED" }
 | { code: "UNKNOWN_ACTION"; action: string };

/** Result of normalizeAndValidateBlockedBy (defined in reducer.ts):
 *  either the cleaned blockedBy array (deduped + validated), or the
 *  first failure encountered. create / update / future deps commands
 *  all share this pipeline so invariants live in one place. */
export type BlockedByValidationResult =
 | { ok: true; value: number[] }
 | { ok: false; error: MutationError };

// ── Graph types (P0-A1) ─────────────────────────────────────────────────
//
// Pure task-graph semantics. Consumed by graph.ts. graph.ts never
// references projection-layer concepts (READY/BLOCKED/RUNNING/visible).

/** Structurally invalid dependency reference in a task's blockedBy.
 *  - missing: id not present in state.tasks
 *  - deleted: id present but status === "deleted" (terminal tombstone)
 *  pending / in_progress are valid graph nodes and therefore NOT broken. */
export type BrokenDependency = {
 id: number;
 reason: "missing" | "deleted";
};

/** A broken dependency ref attributed to the task that holds it.
 *  Used by whyBlocked to identify each bad ref along the blocker chain. */
export type BrokenDependencyRef = {
 taskId: number;
 dependencyId: number;
 reason: "missing" | "deleted";
};

/** Structured explanation of why a task cannot run. */
export interface WhyBlockedResult {
 /** Direct unsatisfied deps (pending or in_progress). */
 direct: Task[];
 /** Tasks at the leaves of the unsatisfied blocker closure — nodes
  *  with no unsatisfied direct dep. A node whose only deps are broken
  *  is still a root (broken deps are surfaced separately). */
 roots: Task[];
 /** Aggregated broken refs across the entire blocker closure. */
 broken: BrokenDependencyRef[];
}

/** Hypothetical graph impact if a task were moved to "completed"
 *  (without mutating state). Speaks in graph terms only — projection
 *  decides whether newlySatisfied are also *visible* (not archived). */
export interface CompletionImpact {
 /** Pending direct dependents whose dep set becomes fully satisfied
  *  after the task completes. */
 newlySatisfied: Task[];
 /** All non-deleted tasks transitively reachable via reverse
  *  dependency edges. Includes newlySatisfied. */
 downstream: Task[];
}

// ── Projection types (P0-B) ──────────────────────────────────────────────────
//
// View-layer types consumed by projection.ts. The active classification
// and ActiveView are UI roles (not domain statuses) — they reflect
// "what the user sees in the working panel". ActiveViewDiff is a neutral
// transition delta between two projections, consumed by P1 mutation
// formatters (Now ready / Re-blocked).

/** Projection-level role. `undefined` means the task has no active role
 *  (archived, deleted, or completed). See classifyTask contract. */
export type ActiveClassification = "running" | "ready" | "blocked";

/** Single snapshot projection. */
export interface ActiveView {
 running: Task[];
 ready: Task[];
 blocked: Task[];
 counts: {
  /** running + ready + blocked */
  active: number;
  /** status === "completed" && archivedAt === undefined */
  completedVisible: number;
 };
}

/** Neutral transition diff between two projections. Membership-based:
 *  subject edits do NOT cause becameReady/becameBlocked, only actual
 *  status/dep changes do. */
export interface ActiveViewDiff {
 becameReady: Task[];
 becameBlocked: Task[];
}

// ── Presentation types (P0-B / B2) ────────────────────────────────────────
//
// Format layer contracts. Formatter does NOT classify, read graph, or scan
// state — it consumes pre-computed projection output and presentation
// hints from the caller. Width contracts are ANSI-free input:
// plain-text layout is computed first; ANSI styling is a future layer
// applied AFTER layout (so it never affects width measurement).

/** Visual role for a single row. Decided by caller (B3/B4); formatter
 *  only renders based on what's passed in. */
export type TaskRowRole =
 | "running"
 | "ready"
 | "blocked"
 | "completed"
 | "closed"
 | "archived";

/** Pre-computed dependency presentation. Caller derives this from
 *  graph.unsatisfiedDependencies + graph.brokenDependencies. Formatter
 *  uses it directly without re-deriving from task.blockedBy. */
export type TaskDependencyKind = "waiting" | "missing" | "deleted";

export interface TaskDependencyPresentation {
 id: number;
 kind: TaskDependencyKind;
}

/** formatTaskRow context. */
export interface TaskRowContext {
 role: TaskRowRole;
 /** Total terminal columns available for this row. */
 width: number;
 dependencies?: readonly TaskDependencyPresentation[];
}

/** formatTaskDetail context. */
export interface TaskDetailContext {
 width: number;
 /** Projection role for the "State" line. If absent, line is hidden. */
 role?: TaskRowRole;
 dependencies?: readonly TaskDependencyPresentation[];
 reverseDependencyIds?: readonly number[];
}

/** formatTodosSnapshot context. */
export interface TodosSnapshotContext {
 width: number;
 /** Per-task dependency presentation for BLOCKED rows. Map keys are
  *  task ids; missing keys default to no deps suffix. */
 dependencies?: ReadonlyMap<number, readonly TaskDependencyPresentation[]>;
}

// ── CLI command types (P0-B / B3) ────────────────────────────────────────────

/** /todos command verbs. parsed from raw args string in index.ts. */
export type TodosCommand =
 | "default"
 | "detail"
 | "ready"
 | "blocked"
 | "completed"
 | "archived"
 | "all"
 | "unknown"; // fail closed

export interface ParseTodosResult {
 command: TodosCommand;
 /** Only set when command === "detail". */
 taskId?: number;
}

// ── Tool parameters (open bag) + JSON Schema ────────────────────────────
//
// `parameters` is a JSON Schema literal — TypeBox schemas (what pi's
// built-in tools use) ARE JSON Schema, so a hand-written literal passes
// pi's validation without pulling a schema library into runtime deps.

export interface TaskMutationParams {
 [key: string]: unknown;
 subject?: string;
 description?: string;
 activeForm?: string;
 status?: TaskStatus;
 blockedBy?: number[];
 addBlockedBy?: number[];
 removeBlockedBy?: number[];
 owner?: string;
 metadata?: Record<string, unknown>;
 closeReason?: string;
 id?: number;
 includeDeleted?: boolean;
 /** Task ids for batch operations (archive, restore). */
 ids?: number[];
}

export const TODO_PARAMS_SCHEMA = {
 type: "object",
 properties: {
  action: {
   type: "string",
   enum: [
    "create",
    "update",
    "list",
    "get",
    "delete",
    "clear",
    "start",
    "finish",
    "reopen",
    "close",
    "archive",
    "restore",
   ],
   description:
    "Operation: create (new task), update (change fields/status/deps), list (all tasks), get (one task), delete (tombstone), clear (reset all), start (pending → in_progress), finish (in_progress → completed), reopen (completed or closed → pending), close (intentionally end an active task without claiming completion), archive (visibility off, completed only), restore (visibility on, batch via ids).",
  },
  subject: {
   type: "string",
   description: "Short imperative task title (required for create).",
  },
  description: { type: "string", description: "Long-form task detail." },
  activeForm: {
   type: "string",
   description:
    "Present-continuous label shown while the task is in_progress, e.g. 'writing tests'.",
  },
  status: {
   type: "string",
   enum: ["pending", "in_progress", "completed", "deleted"],
   description:
    "update: set this task's status. list: filter by this status. Transitions: pending ⇔ in_progress → completed → deleted (deleted is terminal).",
  },
  blockedBy: {
   type: "array",
   items: { type: "number" },
   description: "Initial blockedBy task ids (create only).",
  },
  addBlockedBy: {
   type: "array",
   items: { type: "number" },
   description: "Task ids to add to blockedBy (update only, additive).",
  },
  removeBlockedBy: {
   type: "array",
   items: { type: "number" },
   description: "Task ids to remove from blockedBy (update only).",
  },
  owner: { type: "string", description: "Owner label for this task." },
  metadata: {
   type: "object",
   additionalProperties: true,
   description:
    "Arbitrary metadata. update: pass null as a value to delete that key.",
  },
  closeReason: {
   type: "string",
   description: "Optional reason recorded when close ends an unfinished task.",
  },
  id: {
   type: "number",
   description: "Task id (required for update, get, delete).",
  },
  includeDeleted: {
   type: "boolean",
   description: "list: include deleted tombstones. Default false.",
  },
  ids: {
   type: "array",
   items: { type: "number" },
   description: "Task ids for batch operations (archive, restore).",
  },
 },
 required: ["action"],
} as const;

// ── P1 mutation types ──────────────────────────────────────────────────────────────

/** P1 mutation commands.
 *  - start / finish / reopen: single-id only (P1 v0). Explicit id allows
 *    the caller to fail-fast on bad intent; no selector vocabulary on
 *    lifecycle mutations to avoid batch order / mid-graph state questions.
 *  - archive / restore: take a selector. Selector policy (allowed named
 *    values, "all" rejection, etc.) lives in validateMutationCommand.
 *  Mutation rules themselves (illegal transitions, tombstones, etc.)
 *  remain owned exclusively by the frozen reducer. */
export type MutationCommand =
 | { kind: "start"; id: TaskId }
 | { kind: "finish"; id: TaskId }
 | { kind: "reopen"; id: TaskId }
 | { kind: "close"; id: TaskId }
 | { kind: "archive"; selector: Selector }
 | { kind: "restore"; selector: Selector };

/** Selector AST. ids = explicit list (user order, dedup at resolve).
 *  named = "completed" | "archived" | "all". `all` is parser-recognized
 *  but policy-rejected by archive/restore in P1 v0 (see
 *  validateMutationCommand). */
export type Selector =
 | { kind: "ids"; ids: TaskId[] }
 | { kind: "named"; name: "completed" | "archived" | "all" };

/** Policy rejection (unified code; context fields describe the case).
 *  P1 v0 has exactly four rejected (command, selector) combinations:
 *    archive archived, archive all, restore completed, restore all.
 *  All reported as SELECTOR_NOT_ALLOWED. */
export type MutationUsageError = {
 code: "SELECTOR_NOT_ALLOWED";
 command: "archive" | "restore";
 selector: "completed" | "archived" | "all";
};

export type MutationPolicyDecision =
 | { ok: true }
 | { ok: false; error: MutationUsageError };

/** Result of resolveSelectorIds. explicit nonexistent AND explicit
 *  deleted tombstone BOTH surface as `notFound` — user cannot distinguish
 *  them. formatter renders uniformly as "Task #X not found." */
export type ResolveResult =
 | { ok: true; ids: TaskId[] }
 | { ok: false; notFound: TaskId[] };
