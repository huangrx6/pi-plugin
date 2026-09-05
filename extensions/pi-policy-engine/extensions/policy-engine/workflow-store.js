import {
  saveStrictState,
  clearStrictState,
} from "../../src/core/history-store.js";
import { buildEffectiveConfig, resolveStrictStatePath } from "./state.js";
import { notify } from "./helpers.js";
import { readPlanReport } from "../../src/core/task-contract.js";
export const WORKFLOW_TYPE = "policy-engine-workflow";
export function workflowSnapshot(state, cwd) {
  return structuredClone({
    version: 3,
    ts: Date.now(),
    sessionId: state.sessionId,
    cwd,
    phase: state.phase,
    task: state.task,
    decision: state.lastDecision,
    lastPrompt: state.lastPrompt,
    outcome: state.outcome,
  });
}
export function restoreWorkflow(entries, sessionId, cwd) {
  for (const entry of [...entries].reverse()) {
    const d = entry?.data;
    if (entry?.type !== "custom" || entry.customType !== WORKFLOW_TYPE)
      continue;
    if (
      ![2, 3].includes(d?.version) ||
      d.sessionId !== sessionId ||
      d.cwd !== cwd ||
      !["idle", "planning", "awaiting_approval", "executing"].includes(d.phase)
    )
      return null;
    if (
      !Number.isFinite(d.ts) ||
      Date.now() - d.ts > 7 * 24 * 3600 * 1000 ||
      d.ts > Date.now() + 60000
    )
      return null;
    if (
      d.phase === "awaiting_approval" &&
      (!d.task?.id ||
        !d.task.planEntryId ||
        !entries.some((e) => e.id === d.task.planEntryId))
    )
      return null;
    const restored = structuredClone(d);
    if (restored.phase === "awaiting_approval" && restored.task?.plan) {
      const entry = entries.find((e) => e.id === restored.task.planEntryId);
      const text =
        entry?.message?.content
          ?.filter?.((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "";
      const report =
        entry?.message?.role === "assistant"
          ? readPlanReport(text, restored.task)
          : null;
      if (
        !report ||
        JSON.stringify(report) !== JSON.stringify(restored.task.plan)
      )
        return null;
    }
    if (restored.phase === "awaiting_approval" && !restored.task?.plan) {
      restored.phase = "planning";
      restored.outcome = "missing_plan";
      delete restored.task.approvedVersion;
    }
    return restored;
  }
  return null;
}
export async function persistWorkflow({ pi, state, ctx, packageRoot }) {
  const cwd = ctx?.cwd ?? process.cwd();
  const config = buildEffectiveConfig({ packageRoot, cwd, state });
  const snapshot = workflowSnapshot(state, cwd);
  pi?.appendEntry?.(WORKFLOW_TYPE, snapshot);
  // A host without session identity still has in-memory state, never a shared cwd approval file.
  if (!state.sessionId) return;
  const path = resolveStrictStatePath(config, cwd, state.sessionId);
  if (!path) return;
  const result =
    state.phase === "awaiting_approval" && state.lastDecision
      ? await saveStrictState(path, {
          ...snapshot,
          decision: state.lastDecision,
        })
      : await clearStrictState(path);
  if (!result.ok)
    notify(ctx, `Policy state could not be saved: ${result.reason}`, "warning");
}
