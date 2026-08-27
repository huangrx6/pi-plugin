/**
 * Domain types + the tool parameter schema. No runtime pi imports —
 * only type imports, so the extension loads with zero module resolution
 * beyond its own files.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction =
  | "create"
  | "update"
  | "list"
  | "get"
  | "delete"
  | "clear";

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
 */
export interface TodoDetails {
  tasks: Task[];
  nextId: number;
}

/** Structural check for replay: is this details payload ours? */
export function isTodoDetails(value: unknown): value is TodoDetails {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.tasks) && typeof v.nextId === "number";
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
  id?: number;
  includeDeleted?: boolean;
}

export const TODO_PARAMS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "update", "list", "get", "delete", "clear"],
      description:
        "Operation: create (new task), update (change fields/status/deps), list (all tasks), get (one task), delete (tombstone), clear (reset all).",
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
        "update: set this task's status. list: filter by this status. Transitions: pending ⇄ in_progress → completed → deleted (deleted is terminal).",
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
    id: {
      type: "number",
      description: "Task id (required for update, get, delete).",
    },
    includeDeleted: {
      type: "boolean",
      description: "list: include deleted tombstones. Default false.",
    },
  },
  required: ["action"],
} as const;
