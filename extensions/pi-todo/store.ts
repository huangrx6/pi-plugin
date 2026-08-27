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

import { EMPTY_STATE, isTodoDetails, type TaskState } from "./types.ts";

const sessions = new Map<string, TaskState>();

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
   message?: { role?: string; toolName?: string; details?: unknown };
  };
  if (e.type !== "message") continue;
  const msg = e.message;
  if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
  if (!isTodoDetails(msg.details)) continue;
  result = {
   tasks: msg.details.tasks.map((t) => ({ ...t })),
   nextId: msg.details.nextId,
  };
 }
 return result;
}
