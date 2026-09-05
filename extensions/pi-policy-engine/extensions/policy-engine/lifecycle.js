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
import { createAgentClassifier } from "./agent-classifier.js";
import { buildTurnBlock } from "./policy-block.js";
import { persistWorkflow, restoreWorkflow } from "./workflow-store.js";
import { readPlanReport } from "../../src/core/task-contract.js";
import { appendPolicyToProviderPayload } from "../../src/core/provider-payload.js";

export function registerLifecycleHandlers(pi, { packageRoot, getState }) {
  async function restore(_event, ctx) {
    const state = getState();
    const cwd = ctx?.cwd ?? process.cwd();
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const runtimeMode =
      _event?.type === "session_tree" ? state.runtimeMode : null;
    const runtimeRecognition =
      _event?.type === "session_tree" ? state.runtimeRecognition : null;
    Object.assign(state, createState(), {
      runtimeMode,
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
      state.lastPolicyNote = saved.lastPolicyNote ?? null;
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
        state.lastPolicyNote = savedDisk.lastPolicyNote ?? null;
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

  function conversationFromMessages(messages) {
    return (messages ?? [])
      .filter((message) => message?.role && message.role !== "toolResult")
      .slice(-24)
      .map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content.slice(0, 6000)
            : message.content
                ?.filter?.((part) => part?.type === "text")
                .map((part) => part.text)
                .join("\n")
                .slice(0, 6000) ?? "",
      }));
  }

  function lastUserPrompt(messages, fallback = "") {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      if (typeof message.content === "string") return message.content;
      const text = message.content
        ?.filter?.((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text) return text;
    }
    return fallback;
  }

  function workingMessage(ctx, text) {
    if (typeof ctx?.ui?.setWorkingMessage === "function")
      ctx.ui.setWorkingMessage(text);
    if (text && typeof ctx?.ui?.setWorkingVisible === "function")
      ctx.ui.setWorkingVisible(true);
  }

  // This only marks a possible interrupted-run resume. It never decides the
  // intent or strategy; the current model still recognizes the message below.
  // Keep the candidate phrases small and exact so natural-language task
  // changes continue through the normal recognition path.
  function isExplicitResumeCommand(prompt) {
    const normalized = String(prompt ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s，。！？,.!?；;:：]+/g, " ")
      .trim();
    return new Set([
      "继续",
      "继续执行",
      "继续处理",
      "恢复任务",
      "continue",
      "continue working",
      "resume",
      "resume task",
    ]).has(normalized);
  }

  function shouldReuseInterruptedPolicy(state, prompt) {
    const samePromptRetry =
      String(state.lastPrompt ?? "").trim() === String(prompt ?? "").trim();
    return (
      state.outcome === "interrupted" &&
      !!state.lastDecision &&
      !!state.task &&
      (isExplicitResumeCommand(prompt) || samePromptRetry)
    );
  }

  function policySelectionFingerprint(decision) {
    return fingerprint({
      taskType: decision?.taskType,
      executionIntent: decision?.executionIntent,
      risk: decision?.risk,
      domains: decision?.domains,
      concerns: decision?.concerns,
      coverage: decision?.coverage,
      rigor: decision?.rigor,
      flow: decision?.flow,
      profile: decision?.profile,
      intentPolicy: decision?.intentPolicy,
      approvalRequired: decision?.approvalRequired,
      preflightBlocked: decision?.preflightBlocked,
      modelPolicy: decision?.modelPolicy,
    });
  }

  function previousTurnSnapshot(state) {
    return {
      task: structuredClone(state.task),
      decision: structuredClone(state.lastDecision),
      lastPrompt: state.lastPrompt,
      phase: state.phase,
      note: state.lastPolicyNote,
      injected: state.lastActivity?.injected ?? null,
    };
  }

  async function resolveAndApply({
    event,
    ctx,
    state,
    prompt,
    resumeCandidate = false,
  }) {
    const phaseFrom = state.phase;
    const previous =
      resumeCandidate && state.lastDecision
        ? previousTurnSnapshot(state)
        : null;
    const previewConfig = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });
    const recognitionEnabled = previewConfig.recognition?.enabled === true;
    const hostRecognition =
      recognitionEnabled && previewConfig.recognition?.source === "agent";
    if (recognitionEnabled) workingMessage(ctx, "意图识别中…");
    let turn = await resolveTurn({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      prompt,
      state,
      model: state.currentModel,
      agentClassifier: hostRecognition ? createAgentClassifier(ctx) : null,
      conversation: conversationFromMessages(event?.messages),
    });
    let built = turn.inject
      ? buildTurnBlock({
          packageRoot,
          cwd: ctx?.cwd ?? process.cwd(),
          turn,
          model: state.currentModel,
        })
      : { injected: "" };
    let policyUnchanged = false;
    if (
      previous?.injected &&
      turn.inject &&
      ["continue", "response", "uncertain"].includes(turn.relation) &&
      !turn.decision.preflightBlocked &&
      policySelectionFingerprint(previous.decision) ===
        policySelectionFingerprint(turn.decision)
    ) {
      const resolvedTask = state.task;
      const resolvedDecision = state.lastDecision;
      const resolvedPrompt = state.lastPrompt;
      const resolvedPhase = state.phase;
      state.task = previous.task;
      const reusedDecision = previous.decision;
      reusedDecision.recognition = {
        ...structuredClone(turn.decision.recognition),
        policyUnchanged: true,
      };
      const reusedTurn = {
        ...turn,
        decision: reusedDecision,
        phase: previous.phase === "idle" ? turn.phase : previous.phase,
        note: previous.note ?? turn.note,
        reusedPolicy: true,
      };
      const reusedBuilt = buildTurnBlock({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        turn: reusedTurn,
        model: state.currentModel,
      });
      if (reusedBuilt.injected === previous.injected) {
        turn = reusedTurn;
        built = reusedBuilt;
        policyUnchanged = true;
        state.lastDecision = reusedDecision;
        state.lastPrompt = previous.lastPrompt;
        state.phase = reusedTurn.phase;
      } else {
        state.task = resolvedTask;
        state.lastDecision = resolvedDecision;
        state.lastPrompt = resolvedPrompt;
        state.phase = resolvedPhase;
      }
    }
    state.lastPolicyNote = turn.note;
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
    await history(
      state,
      ctx,
      policyUnchanged ? "reuse" : "decide",
      prompt,
      turn.decision,
      phaseFrom,
      {
        relation: turn.relation,
        policyUnchanged,
        configFingerprint: fingerprint({
          ...turn.config,
          _sources: undefined,
          _diagnostics: undefined,
        }),
        injectionFingerprint: fingerprint(built.injected),
        injectedBytes: Buffer.byteLength(built.injected),
      },
    );
    publishActivity(pi, state, ctx, built.injected, turn.decision);
    await persistWorkflow({ pi, state, ctx, packageRoot });
    state.turnContext = {
      prompt,
      injected: built.injected,
      decision: turn.decision,
      config: turn.config,
      preflight: recognitionEnabled,
      preflightDone: true,
      reused: policyUnchanged,
      policyUnchanged,
    };
    // Restore Pi's normal spinner text after the short policy preflight. The
    // spinner itself remains owned by the host agent loop.
    if (recognitionEnabled) workingMessage(ctx);
    return { turn, built };
  }

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
    const prompt = String(event.prompt ?? "");
    state.currentModel = cleanModel(ctx?.model ?? state.currentModel);
    state.turnContext = {
      prompt,
      injected: "",
      preflightDone: false,
      resumeCandidate: shouldReuseInterruptedPolicy(state, prompt),
    };
    // Older hosts without the Working-message API cannot provide the modern
    // message-first lifecycle. Keep a compatibility path for them; current
    // Pi versions take the deferred `context` path below.
    if (typeof ctx?.ui?.setWorkingMessage !== "function") {
      const { built } = await resolveAndApply({
        event: {
          messages:
            ctx?.sessionManager?.getBranch?.()?.map?.(
              (entry) => entry.message,
            ) ?? [],
        },
        ctx,
        state,
        prompt,
        resumeCandidate: state.turnContext.resumeCandidate,
      });
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      if (cfg.showStatus !== false)
        setStatus(
          ctx,
          `policy:${state.lastDecision?.rigor ?? "off"}/${state.phase}`,
        );
      return built.injected
        ? { systemPrompt: `${event.systemPrompt ?? ""}\n\n${built.injected}` }
        : undefined;
    }
    // Policy resolution intentionally does not run here. Pi has not emitted
    // the user's message or entered its Working state at this lifecycle point.
    return undefined;
  });
  pi.on("context", async (event, ctx) => {
    const state = getState();
    const pending = state.turnContext;
    if (!pending || pending.preflightDone) return;
    const prompt = pending.prompt || lastUserPrompt(event?.messages);
    if (!prompt) return;
    pending.preflightDone = true;
    await resolveAndApply({
      event,
      ctx,
      state,
      prompt,
      resumeCandidate: pending.resumeCandidate,
    });
    const cfg = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });
    if (cfg.showStatus !== false)
      setStatus(ctx, `policy:${state.lastDecision?.rigor ?? "off"}/${state.phase}`);
    return { messages: event.messages };
  });
  pi.on("before_provider_request", async (event) => {
    const injected = getState().turnContext?.injected;
    if (!injected) return undefined;
    return appendPolicyToProviderPayload(event.payload, injected);
  });
  pi.on("agent_end", async (event, ctx) => {
    const state = getState();
    if (state.turnRelation === "conversation") {
      workingMessage(ctx);
      return;
    }
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
    workingMessage(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    // Pi can auto-retry or auto-compact after agent_end. Keep the selected
    // policy available for those provider requests and clear it only once the
    // host confirms that no continuation remains.
    workingMessage(ctx);
    getState().turnContext = null;
  });
}
