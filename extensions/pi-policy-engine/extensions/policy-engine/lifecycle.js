// Event handler registration: session_start, model_select, before_agent_start,
// agent_end. Owns the strict-workflow state machine.
//
// v0.15 state machine (single source of truth = `phase`):
//   idle
//     ↓ strict task classified (mutate intent)
//   planning            ← model produces the plan this turn
//     ↓ agent_end
//   awaiting_approval   ← classifyPlanResponse() routes the next prompt:
//     ├─ approve → executing
//     ├─ revise  → planning (plan updated, re-approval required)
//     ├─ discuss → awaiting_approval (question answered, plan untouched)
//     ├─ cancel  → idle
//     └─ unknown → awaiting_approval
//   executing
//     ↓ agent_end
//   idle
//
// v0.12 note still applies: no tool_call handler — model-behavior layer only.

import { classifyPlanResponse } from "../../src/core/approval.js";
import {
  composeAllPolicies,
  renderPolicyBlock,
} from "../../src/core/loader.js";
import {
  appendHistory,
  readHistory,
  resolveHistoryPath,
} from "../../src/core/history-store.js";
import { cleanModel, modelKey, notify, setStatus } from "./helpers.js";
import {
  HISTORY_CAP,
  buildEffectiveConfig,
  decide,
  recordHistory,
} from "./state.js";

/**
 * Compose + render the policy block for a decision/phase, and update the
 * decision's loaded/truncated bookkeeping. Shared by every branch that
 * injects a system-prompt block.
 */
function buildBlock({ packageRoot, cwd, config, decision, phase }) {
  // v0.17: one TOTAL byte budget — project policies participate in
  // policyMaxBytes after built-ins (composeAllPolicies).
  const { policies, projectPolicies, truncated } = composeAllPolicies({
    packageRoot,
    cwd,
    decision,
    config,
    phase,
  });
  decision.loadedPolicies = [...policies, ...projectPolicies].map((p) => p.id);
  decision.truncatedPolicies = truncated;
  return renderPolicyBlock({
    decision,
    policies,
    projectPolicies,
    phase,
    truncated,
  });
}

export function registerLifecycleHandlers(pi, { packageRoot, getState }) {
  pi.on("session_start", async (_event, ctx) => {
    const state = getState();
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
    // Read at most HISTORY_CAP entries — the in-memory ring buffer can't
    // hold more, so reading historyMaxEntries lines just to slice them down
    // is wasted IO.
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

    // ---- awaiting_approval: route the user's plan response ----------------

    if (state.phase === "awaiting_approval" && state.lastDecision) {
      const verdict = classifyPlanResponse(prompt);
      const cfgAwait = buildEffectiveConfig({
        packageRoot,
        cwd,
        state,
      });

      if (verdict === "cancel") {
        state.phase = "idle";
        state.lastDecision = null;
        if (cfgAwait.showStatus !== false) setStatus(ctx, "policy:idle");
        notify(ctx, "Strict plan cancelled.", "info");
        return undefined;
      }

      if (verdict === "discuss") {
        // Question about the plan: answer it, keep waiting for approval.
        const decision = { ...state.lastDecision };
        state.lastDecision = decision;
        const block = buildBlock({
          packageRoot,
          cwd,
          config: cfgAwait,
          decision,
          phase: "awaiting_approval",
        });
        if (cfgAwait.showStatus !== false)
          setStatus(ctx, `policy:${decision.workflow}/awaiting_approval`);
        return {
          systemPrompt: `${event.systemPrompt}\n\n${block}\n\n## Pending-plan discussion\nThe user is asking about the pending plan. Answer the question; do not start implementation. The plan still requires explicit approval afterwards.`,
        };
      }

      if (verdict === "revise") {
        // Constraint modification: update the plan, re-approval required.
        const decision = { ...state.lastDecision };
        state.lastDecision = decision;
        state.phase = "planning";
        const block = buildBlock({
          packageRoot,
          cwd,
          config: cfgAwait,
          decision,
          phase: "planning",
        });
        if (cfgAwait.showStatus !== false)
          setStatus(ctx, `policy:${decision.workflow}/planning`);
        return {
          systemPrompt: `${event.systemPrompt}\n\n${block}\n\n## Plan revision requested\nThe user approved the direction but added constraints or modifications. Update the Task Contract, Constraint Ledger, and plan accordingly; present the revised plan and stop for approval again. Do not execute.`,
        };
      }

      if (verdict === "approve") {
        state.phase = "executing";
        const decision = { ...state.lastDecision };
        state.lastDecision = decision;
        const block = buildBlock({
          packageRoot,
          cwd,
          config: cfgAwait,
          decision,
          phase: "executing",
        });
        if (cfgAwait.showStatus !== false)
          setStatus(ctx, `policy:${decision.workflow}/executing`);
        return {
          systemPrompt: `${event.systemPrompt}\n\n${block}\n\n## Approved\nThe plan has been approved by the user. Execute the bounded waves defined in the plan; re-check constraints after each wave.`,
        };
      }

      // unknown: not approval-shaped. Keep awaiting approval and say so,
      // otherwise a casual "继续" would silently sit in limbo.
      const block = buildBlock({
        packageRoot,
        cwd,
        config: cfgAwait,
        decision: state.lastDecision,
        phase: "awaiting_approval",
      });
      if (cfgAwait.showStatus !== false)
        setStatus(
          ctx,
          `policy:${state.lastDecision.workflow}/awaiting_approval`,
        );
      return {
        systemPrompt: `${event.systemPrompt}\n\n${block}\n\n## Still awaiting approval\nThe user's message was not recognized as an approval, revision, or cancellation. Remain in PLAN-ONLY mode; remind the user that the plan is awaiting explicit approval.`,
      };
    }

    // ---- brand new task: classify and route --------------------------------

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
      state.phase = "idle";
      if (config.showStatus !== false) setStatus(ctx, "policy:off");
      return undefined;
    }

    if (
      decision.workflow === "strict" &&
      decision.executionIntent !== "read-only"
    ) {
      state.phase = "planning";
    } else {
      state.phase = "executing";
    }

    const block = buildBlock({
      packageRoot,
      cwd,
      config,
      decision,
      phase: state.phase,
    });

    if (config.showStatus !== false)
      setStatus(ctx, `policy:${decision.workflow}/${state.phase}`);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("agent_end", async (_event, ctx) => {
    const state = getState();
    // The plan turn finished: the ball is now in the user's court.
    if (state.phase === "planning") {
      state.phase = "awaiting_approval";
    } else if (state.phase === "executing") {
      state.phase = "idle";
    }
    const cfg = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });
    if (cfg.showStatus !== false && state.lastDecision) {
      const label =
        state.phase === "idle" ? state.lastDecision.workflow : state.phase;
      setStatus(ctx, `policy:${label}`);
    }
  });
}
