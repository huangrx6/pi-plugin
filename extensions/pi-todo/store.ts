/**
 * Per-session live state + the foreground render pointer.
 *
 * State is partitioned by session id: a child/detached session can never
 * read or clobber another session's tasks. Only commitState /
 * replaceState / evictSession write the Map; the reducer stays pure.
 *
 * FOREGROUND RULE (diverges deliberately from first-claim designs): the
 * render pointer follows the LATEST session_start that has a UI. With
 * first-claim, switching to session B while A stays alive (pi does not
 * fire session_shutdown on foreground switches) left the overlay pinned
 * to A's list forever — B's start saw the pointer taken and bailed.
 * Latest-wins: the overlay always shows the session the user is looking
 * at. session_shutdown of the foreground clears the pointer; the next
 * UI-bearing start reclaims it.
 */

import {
 EMPTY_STATE,
 isTodoDetails,
 normalizeTask,
 type TaskState,
} from "./types.ts";

const sessions = new Map<string, TaskState>();

/**
 * Per-session overlay preference: show the full list (true) or the
 * 12-row collapsed summary (false). NOT persisted to the branch — this
 * is a UI choice the user can re-toggle; persisting it would make replay
 * have to tolerate a missing field on legacy branches AND lose the
 * ability to start a fresh session collapsed regardless of branch.
 */
const expandedBySession = new Map<string, boolean>();

let foreground = "";

export function sid(ctx: {
 sessionManager: { getSessionId(): string };
}): string {
 return ctx.sessionManager.getSessionId() ?? "";
}

function freshState(): TaskState {
 return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function slotFor(id: string): TaskState {
 return sessions.get(id) ?? freshState();
}

export function getState(sessionId: string): TaskState {
 return slotFor(sessionId);
}

/** Test reset — clears every slot and the render pointer. */
export function __resetState(): void {
 sessions.clear();
 foreground = "";
 expandedBySession.clear();
}

/** Replay seam: lifecycle handlers publish a reconstructed snapshot. */
export function replaceState(sessionId: string, next: TaskState): void {
 sessions.set(sessionId, next);
}

/** Post-reducer commit seam: the tool's execute() publishes new state. */
export function commitState(sessionId: string, next: TaskState): void {
 sessions.set(sessionId, next);
}

export function evictSession(sessionId: string): void {
 sessions.delete(sessionId);
 expandedBySession.delete(sessionId);
}

export function getExpanded(sessionId: string): boolean {
 return expandedBySession.get(sessionId) ?? false;
}

export function setExpanded(sessionId: string, value: boolean): void {
 expandedBySession.set(sessionId, value);
}

export function clearExpanded(sessionId: string): void {
 expandedBySession.delete(sessionId);
}

/** Which slot do ctx-free readers (overlay) render. */
export function getRenderState(): TaskState {
 return slotFor(foreground);
}

/** Latest-wins foreground claim (see module header). */
export function setForegroundSession(sessionId: string): void {
 foreground = sessionId;
}

export function getForegroundSession(): string {
 return foreground;
}

export function clearForegroundSession(sessionId: string): void {
 if (foreground === sessionId) foreground = "";
}

/**
 * Reconstruct state by walking the current branch chronologically; the
 * LAST toolResult from our tool whose `details` carries a valid snapshot
 * wins (last-write-wins). Pure — writes nothing, callers commit the
 * result. Survives compaction because branch entries are append-only
 * and never dropped by compaction summaries.
 */
export function replayFromBranch(ctx: {
 sessionManager: { getBranch(): Iterable<unknown> };
}): TaskState {
 let result = freshState();
 for (const entry of ctx.sessionManager.getBranch()) {
  const e = entry as {
   type?: string;
   message?: {
    role?: string;
    toolName?: string;
    details?: unknown;
   };
  };
  if (e.type !== "message") continue;
  const msg = e.message;
  if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
  if (!isTodoDetails(msg.details)) continue;
  // v1 snapshots (schemaVersion === 1) carry full timestamps; shallow-copy.
  // Legacy snapshots (no schemaVersion or !== 1) predate timestamps;
  // per-task normalizeTask fills createdAt=0 / updatedAt=createdAt defaults
  // and passes archivedAt through. See TodoDetails doc on types.ts.
  const isV1 = msg.details.schemaVersion === 1;
  const tasks = isV1
   ? msg.details.tasks.map((t) => ({ ...t }))
   : msg.details.tasks.map((t) => normalizeTask(t));
  result = {
   tasks,
   nextId: msg.details.nextId,
  };
 }
 return result;
}
