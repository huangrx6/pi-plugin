// Pi lifecycle: resolve one turn, compose instructions, and record transitions.
import { publishActivity, restoreActivity } from "./activity.js";
import { resolveTurn } from "./transitions.js";
import {
  buildEffectiveConfig,
  createState,
  recordHistory,
  resolveStrictStatePath,
  fingerprint,
} from "./state.js";
import {
  loadStrictState,
  readHistory,
  appendHistory,
  resolveHistoryPath,
  pruneStrictStates,
} from "../../src/core/history-store.js";
import { cleanModel, notify, setStatus } from "./helpers.js";
import { buildTurnBlock } from "./policy-block.js";
import { persistWorkflow, restoreWorkflow } from "./workflow-store.js";
import { readPlanReport } from "../../src/core/task-contract.js";
import { createAgentClassifier } from "./agent-classifier.js";

export function registerLifecycleHandlers(pi, { packageRoot, getState }) {
  async function restore(_event, ctx) {
    const state = getState();
    const cwd = ctx?.cwd ?? process.cwd();
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const runtimeMode =
      _event?.type === "session_tree" ? state.runtimeMode : null;
    const runtimeProfile =
      _event?.type === "session_tree" ? state.runtimeProfile : null;
    const runtimeRecognition =
      _event?.type === "session_tree" ? state.runtimeRecognition : null;
    Object.assign(state, createState(), {
      runtimeMode,
      runtimeProfile,
      runtimeRecognition,
    });
    state.sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
    state.currentModel = cleanModel(ctx?.model);
    state.lastActivity = restoreActivity(branch);
    const cfg = buildEffectiveConfig({ packageRoot, cwd, state });
    const saved = restoreWorkflow(branch, state.sessionId, cwd);
    if (saved) {
      state.phase = saved.phase;
      state.task = saved.task;
      state.lastDecision = saved.decision;
      state.lastPrompt = saved.lastPrompt;
      state.outcome = saved.outcome;
      if (state.phase === "executing") {
        state.phase = "idle";
        state.outcome = "interrupted";
      }
    } else if (state.sessionId && !ctx?.sessionManager?.getBranch) {
      // Disk fallback only for a session-aware host that cannot expose its branch.
      const savedDisk = await loadStrictState(
        resolveStrictStatePath(cfg, cwd, state.sessionId),
        { cwd, sessionId: state.sessionId },
      );
      if (savedDisk) {
        state.phase = savedDisk.phase;
        state.task = savedDisk.task;
        state.lastDecision = savedDisk.decision;
        if (!state.task?.plan) {
          state.phase = "planning";
          state.outcome = "missing_plan";
        }
      }
    }
    if (cfg.historyFile) {
      const path = resolveHistoryPath(cfg.historyFile, cwd);
      state.history = (
        await readHistory(path, Math.min(cfg.historyMaxEntries, 50))
      ).filter((r) => !r.sessionId || r.sessionId === state.sessionId);
      await pruneStrictStates(path);
    }
    if (cfg.showStatus !== false)
      setStatus(
        ctx,
        `policy:${state.phase === "awaiting_approval" ? "strict/awaiting_approval" : cfg.mode}`,
      );
  }
  pi.on("session_start", restore);
  pi.on("session_tree", (event, ctx) =>
    restore({ ...event, type: "session_tree" }, ctx),
  );
  pi.on("model_select", async (event, ctx) => {
    getState().currentModel = cleanModel(event.model ?? ctx?.model);
  });

  async function history(
    state,
    ctx,
    source,
    prompt,
    decision,
    phaseFrom,
    extra = {},
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    state.recordContext = { cwd, phaseFrom, phaseTo: state.phase, ...extra };
    recordHistory(state, { source, prompt, decision });
    delete state.recordContext;
    const cfg = buildEffectiveConfig({ packageRoot, cwd, state });
    if (cfg.historyFile && state.history.length) {
      const result = await appendHistory(
        resolveHistoryPath(cfg.historyFile, cwd),
        state.history.at(-1),
      );
      if (!result.ok)
        notify(
          ctx,
          `Policy history could not be saved: ${result.reason}`,
          "warning",
        );
    }
  }
  pi.on("before_agent_start", async (event, ctx) => {
    const state = getState();
    const phaseFrom = state.phase;
    const prompt = String(event.prompt ?? "");
    state.currentModel = cleanModel(ctx?.model ?? state.currentModel);
    const turn = await resolveTurn({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      prompt,
      state,
      model: state.currentModel,
      agentClassifier: createAgentClassifier(ctx),
    });
    const built = turn.inject
      ? buildTurnBlock({
          packageRoot,
          cwd: ctx?.cwd ?? process.cwd(),
          turn,
          model: state.currentModel,
        })
      : { injected: "" };
    state.turnRelation = turn.relation;
    state.outcome =
      turn.relation === "conversation"
        ? state.outcome
        : built.blocked
          ? "blocked"
          : turn.inject
            ? "in_progress"
            : "idle";
    if (turn.config._diagnostics.length)
      notify(
        ctx,
        `Policy configuration: ${turn.config._usingLastValid ? "using last valid configuration. " : ""}${turn.config._diagnostics.map((x) => x.message).join("; ")}`,
        "warning",
      );
    await history(state, ctx, "decide", prompt, turn.decision, phaseFrom, {
      relation: turn.relation,
      configFingerprint: fingerprint({
        ...turn.config,
        _sources: undefined,
        _diagnostics: undefined,
      }),
      injectionFingerprint: fingerprint(built.injected),
      injectedBytes: Buffer.byteLength(built.injected),
    });
    publishActivity(pi, state, ctx, built.injected, turn.decision);
    await persistWorkflow({ pi, state, ctx, packageRoot });
    if (turn.config.showStatus !== false)
      setStatus(ctx, `policy:${turn.decision.rigor}/${state.phase}`);
    return built.injected
      ? { systemPrompt: `${event.systemPrompt ?? ""}\n\n${built.injected}` }
      : undefined;
  });
  pi.on("agent_end", async (event, ctx) => {
    const state = getState();
    if (state.turnRelation === "conversation") return;
    const phaseFrom = state.phase;
    const assistant = (event.messages ?? [])
      .filter((m) => m.role === "assistant")
      .at(-1);
    const failed =
      assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
    const text =
      assistant?.content
        ?.filter?.((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "";
    const plan = readPlanReport(text, state.task);
    if (failed)
      state.outcome =
        assistant.stopReason === "aborted" ? "interrupted" : "failed";
    else if (state.outcome !== "blocked") {
      if (state.phase === "planning" && plan) {
        state.phase = "awaiting_approval";
        state.outcome = "awaiting_approval";
        if (state.task) {
          state.task.plan = plan;
          state.task.planEntryId = ctx?.sessionManager?.getLeafId?.() ?? null;
        }
      } else if (state.phase === "executing") {
        state.phase = "idle";
        state.outcome = "unverified";
      } else if (state.phase === "planning") state.outcome = "missing_plan";
    }
    if (state.lastDecision)
      await history(state, ctx, "agent_end", "", state.lastDecision, phaseFrom);
    await persistWorkflow({ pi, state, ctx, packageRoot });
    const cfg = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });
    if (cfg.showStatus !== false)
      setStatus(ctx, `policy:${state.phase}/${state.outcome}`);
  });
}
