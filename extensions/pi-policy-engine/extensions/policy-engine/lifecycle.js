// Event handler registration: session_start, model_select, before_agent_start,
// agent_end. Owns the strict-workflow state machine.
//
// v0.12: no tool_call handler on purpose — this extension works entirely at
// the model-behavior (prompt) layer. Tool permission is out of scope.

import {
  isApprovalPrompt,
  isPlanRevisionPrompt,
} from "../../src/core/approval.js";
import {
  composePolicies,
  loadProjectPolicies,
  renderPolicyBlock,
} from "../../src/core/loader.js";
import {
  appendHistory,
  readHistory,
  resolveHistoryPath,
} from "../../src/core/history-store.js";
import { cleanModel, modelKey, setStatus } from "./helpers.js";
import {
  HISTORY_CAP,
  buildEffectiveConfig,
  decide,
  recordHistory,
} from "./state.js";

/**
 * Wire all event handlers onto the supplied `pi`. `getState()` returns the
 * shared mutable state object created in index.js (so commands.js and
 * lifecycle.js see the same instance).
 */
export function registerLifecycleHandlers(pi, { packageRoot, getState }) {
  pi.on("session_start", async (_event, ctx) => {
    const state = getState();
    state.pendingApproval = false;
    state.phase = "idle";
    state.lastDecision = null;
    state.lastPrompt = null;
    state.history = [];
    state.currentModel = cleanModel(ctx?.model) ?? state.currentModel;
    const cfg = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });

    // Load persisted history (if configured). Best-effort: file missing or
    // unreadable is fine; we just continue with an empty in-memory history.
    // We read at most HISTORY_CAP entries — the in-memory ring buffer can't
    // hold more than that, so reading historyMaxEntries (default 500) lines
    // off disk just to slice(-50) them is wasted IO.
    if (cfg.historyFile) {
      const path = resolveHistoryPath(
        cfg.historyFile,
        ctx?.cwd ?? process.cwd(),
      );
      if (path) {
        const limit = Math.min(
          Number(cfg.historyMaxEntries ?? 500),
          HISTORY_CAP,
        );
        const diskEntries = await readHistory(path, limit);
        if (Array.isArray(diskEntries) && diskEntries.length > 0) {
          state.history = diskEntries;
        }
      }
    }

    if (cfg.showStatus !== false)
      setStatus(ctx, `policy:${cfg.mode ?? "auto"}`);
  });

  pi.on("model_select", async (event, ctx) => {
    const state = getState();
    state.currentModel = cleanModel(event?.model);
    const cfg = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });
    if (cfg.showStatus !== false)
      setStatus(
        ctx,
        `policy:${cfg.mode ?? "auto"} · ${modelKey(state.currentModel)}`,
      );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState();
    const prompt = String(event?.prompt ?? "");
    const cwd = ctx?.cwd ?? process.cwd();

    // Approval follow-up is a continuation of the previous strict task.
    if (
      state.pendingApproval &&
      isApprovalPrompt(prompt) &&
      state.lastDecision
    ) {
      state.pendingApproval = false;
      state.phase = "executing";
      const config = buildEffectiveConfig({ packageRoot, cwd, state });
      const decision = { ...state.lastDecision };
      state.lastDecision = decision;
      const { policies, truncated } = composePolicies({
        packageRoot,
        decision,
        config,
        phase: "executing",
      });
      const projectPolicies = loadProjectPolicies(cwd, config);
      decision.loadedPolicies = [...policies, ...projectPolicies].map(
        (p) => p.id,
      );
      decision.truncatedPolicies = truncated;
      const block = renderPolicyBlock({
        decision,
        policies,
        projectPolicies,
        phase: "executing",
        truncated,
      });
      if (config.showStatus !== false)
        setStatus(ctx, `policy:${decision.workflow}/execute`);
      return {
        systemPrompt: `${event.systemPrompt}\n\n${block}\n\n## Approved\nThe plan has been approved by the user. Execute the bounded waves defined in the plan; re-check constraints after each wave.`,
      };
    }

    // Non-approval follow-up while a strict plan is pending: stay in planning.
    if (state.pendingApproval && state.lastDecision) {
      const config = buildEffectiveConfig({ packageRoot, cwd, state });
      const decision = { ...state.lastDecision };
      state.lastDecision = decision;
      state.phase = "planning";
      state.pendingApproval = true;
      const { policies, truncated } = composePolicies({
        packageRoot,
        decision,
        config,
        phase: "planning",
      });
      const projectPolicies = loadProjectPolicies(cwd, config);
      decision.loadedPolicies = [...policies, ...projectPolicies].map(
        (p) => p.id,
      );
      decision.truncatedPolicies = truncated;
      const block = renderPolicyBlock({
        decision,
        policies,
        projectPolicies,
        phase: "planning",
        truncated,
      });
      const followUp = isPlanRevisionPrompt(prompt)
        ? "The user is revising/rejecting part of the plan. Update the Task Contract, Constraint Ledger, and plan; do not execute."
        : "The user is discussing or questioning the pending plan. Answer/update the plan as needed; do not execute until explicit approval.";
      if (config.showStatus !== false)
        setStatus(ctx, `policy:${decision.workflow}/planning`);
      return {
        systemPrompt: `${event.systemPrompt}\n\n${block}\n\n## Pending-plan follow-up\n${followUp}`,
      };
    }

    // Brand new task: classify and route.
    const { decision, config } = await decide({
      packageRoot,
      cwd,
      prompt,
      state,
      model: cleanModel(ctx?.model ?? state.currentModel),
    });
    state.lastPrompt = prompt;
    state.lastDecision = decision;
    recordHistory(state, { source: "decide", prompt, decision });
    // Fire-and-forget persist to disk if configured.
    if (config.historyFile) {
      const path = resolveHistoryPath(config.historyFile, cwd);
      if (path && state.history.length > 0) {
        const latest = state.history[state.history.length - 1];
        appendHistory(path, latest).catch(() => {});
      }
    }

    if (state.onceMode) state.onceMode = null;

    if (decision.workflow === "off") {
      state.pendingApproval = false;
      state.phase = "idle";
      if (config.showStatus !== false) setStatus(ctx, "policy:off");
      return undefined;
    }

    if (decision.workflow === "strict" && decision.executionIntent !== "read-only") {
      state.pendingApproval = true;
      state.phase = "planning";
    } else {
      state.pendingApproval = false;
      state.phase = "executing";
    }

    const { policies, truncated } = composePolicies({
      packageRoot,
      decision,
      config,
      phase: state.phase,
    });
    const projectPolicies = loadProjectPolicies(cwd, config);
    decision.loadedPolicies = [...policies, ...projectPolicies].map(
      (p) => p.id,
    );
    decision.truncatedPolicies = truncated;
    const block = renderPolicyBlock({
      decision,
      policies,
      projectPolicies,
      phase: state.phase,
      truncated,
    });

    if (config.showStatus !== false)
      setStatus(ctx, `policy:${decision.workflow}/${state.phase}`);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState();
    if (!state.pendingApproval && state.phase === "executing") {
      state.phase = "idle";
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      if (cfg.showStatus !== false && state.lastDecision) {
        setStatus(ctx, `policy:${state.lastDecision.workflow}`);
      }
    }
  });
}
