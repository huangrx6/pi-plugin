// Shared turn resolution for the lifecycle and side-effect-free previews.
import {
  resolvePlanResponse,
  hasAutonomyGrant,
} from "../../src/core/approval.js";
import {
  extractExecutionMeta,
  classifyFollowUp,
} from "../../src/core/intent.js";
import { isConversation, unquotedText } from "../../src/core/language.js";
import { chooseRigor } from "../../src/core/router.js";
import { interpretTask } from "../../src/core/interpretation.js";
import {
  rememberRequirements,
  contractNote,
} from "../../src/core/task-contract.js";
import {
  buildEffectiveConfig,
  decide,
  mergeRevisionDecision,
  newTask,
} from "./state.js";

export function taskRelation(prompt) {
  if (isConversation(prompt)) return "conversation";
  if (classifyFollowUp(prompt).type !== "none") return "response";
  const text = unquotedText(prompt)
    .trim()
    .replace(/^(?:我想|另外)(?:请|帮我)?/, "");
  if (
    /^(?:请|帮我|先)?(?:修改|调整|更新|重新制定)(?:一下)?(?:计划|方案)/.test(
      text,
    )
  )
    return "response";
  if (
    /^(?:换个任务|新任务|另外一个任务|先不做这个|new task|switch tasks)/i.test(
      text,
    )
  )
    return "new";
  if (
    /(?:这个计划|原计划|该计划|这个方案|原方案|第[一二三四五六七八九十\d]+步|当前任务|this plan|the plan|step\s*\d)/i.test(
      text,
    )
  )
    return "response";
  if (
    /^(?:你|请|麻烦|帮我|现在|先|再|全面|全局|重新|进行|\s)*(?:审查|评审|检查|分析|调研|研究|评估|梳理|修复|创建|实现|编写|设计|修改|优化|完善|升级|review\b|inspect\b|analy[sz]e\b|implement\b|fix\b|create\b)/i.test(
      text,
    )
  )
    return "new";
  return "response";
}

export async function resolveTurn({
  packageRoot,
  cwd,
  prompt,
  state,
  model,
  fetcher,
  semantic = true,
}) {
  const config = buildEffectiveConfig({ packageRoot, cwd, state });
  let mode = config.mode;
  const recognition =
    semantic && mode !== "off"
      ? await interpretTask({
          prompt,
          state,
          config,
          fetcher,
          currentModel: model,
        })
      : {
          source: "rules",
          reason: semantic ? "off" : "preview_offline",
          interpretation: null,
        };
  const interpreted = recognition.interpretation;
  let relation = interpreted?.relation ?? taskRelation(prompt);
  const isContinuationPhrase = classifyFollowUp(prompt).type !== "none";
  const recoverFromConversation =
    recognition.source === "agent" &&
    recognition.reason === "in_band" &&
    !state.task &&
    relation === "response" &&
    isContinuationPhrase;
  if (recoverFromConversation) relation = "uncertain";
  // The user's explicit response to a pending plan outranks a model's task split.
  const localApproval = resolvePlanResponse(prompt);
  if (
    state.phase === "awaiting_approval" &&
    ["approve", "cancel"].includes(localApproval.verdict)
  )
    relation = "response";
  if (!state.task && !["conversation", "uncertain"].includes(relation))
    relation = "new";
  if (relation === "new") mode = state.onceMode ?? mode;
  const recognitionNote = `recognition:${recognition.source}/${recognition.reason}`;
  let note = "";
  let verdict = null;
  if (relation === "conversation") {
    return {
      config,
      relation,
      decision: {
        taskType: "conversation",
        executionIntent: "read-only",
        rigor: "off",
        risk: "low",
        confidence: recognition.source === "model" ? null : 1,
        reasons: ["message: ordinary conversation; task state unchanged"],
        domains: [],
        concerns: [],
        recognition,
      },
      phase: state.phase,
      note,
      inject: false,
    };
  }
  if (mode === "off") {
    state.phase = "idle";
    state.task = null;
    state.onceMode = null;
    const { decision } = await decide({
      packageRoot,
      cwd,
      prompt,
      state,
      model,
      semantic: false,
      explicitMode: "off",
    });
    state.lastDecision = decision;
    return {
      config,
      relation: "off",
      decision,
      phase: state.phase,
      note,
      inject: false,
    };
  }
  if (
    state.phase === "awaiting_approval" &&
    state.lastDecision &&
    relation !== "new"
  ) {
    const approval = localApproval;
    verdict = approval.verdict;
    if (verdict === "unknown" && interpreted?.relation === "revise")
      verdict = "revise";
    if (verdict === "unknown" && interpreted?.relation === "discuss")
      verdict = "discuss";
    const prior = state.lastDecision;
    state.task ??= newTask(state.lastPrompt ?? "Pending task");
    if (verdict === "cancel") {
      state.phase = "idle";
      state.task = null;
      state.lastDecision = null;
      state.lastPrompt = null;
      return {
        config,
        relation: "cancel",
        decision: { ...prior, rigor: "off" },
        phase: "idle",
        note,
        inject: false,
      };
    }
    let decision = structuredClone(prior);
    if (
      verdict === "revise" ||
      (verdict === "approve" &&
        (approval.autonomy || approval.constraints.length))
    ) {
      decision = interpreted
        ? (
            await decide({
              packageRoot,
              cwd,
              prompt,
              state,
              model,
              semantic: false,
              relation: "revise",
              interpretation: interpreted,
            })
          ).decision
        : mergeRevisionDecision({
            previous: prior,
            prompt,
            config,
            packageRoot,
          });
      state.task.planVersion++;
      delete state.task.plan;
      delete state.task.planEntryId;
    }
    if (state.runtimeProfile || config.profile !== "auto")
      decision.profile = config.profile;
    if (verdict === "approve") {
      state.phase = "executing";
      state.task.autonomy ||= approval.autonomy;
      state.task.constraints = [
        ...new Set([
          ...(state.task.constraints ?? []),
          ...approval.constraints,
        ]),
      ];
      state.task.approvedVersion = state.task.planVersion;
      state.task.authorizationSource = "user_message";
      note =
        "## Approved\nThe user has approved the current task. Execute within its approved scope and honor all accompanying constraints.";
    } else if (verdict === "revise") {
      delete state.task.approvedVersion;
      state.phase =
        decision.executionIntent === "read-only" ? "executing" : "planning";
      note =
        state.phase === "planning"
          ? "## Plan revision requested\nUpdate the plan to reflect the user's new constraints. Do not execute until the revised scope is approved."
          : "## Read-only task\nComplete the requested inspection and report findings; do not request implementation approval for read-only work.";
    } else {
      state.phase = "awaiting_approval";
      note =
        verdict === "discuss"
          ? "## Pending-plan discussion\nAnswer the question; do not start implementation. The plan still requires explicit approval."
          : "## Still awaiting approval\nRemain in PLAN-ONLY mode. The message does not authorize implementation; explain the pending state only when relevant.";
    }
    // Mode changes change depth, never fabricate approval for a pending plan.
    if (state.onceMode) {
      decision.reasons = [
        ...decision.reasons,
        `mode:${state.onceMode} reserved for the next new task; pending authorization remains authoritative`,
      ];
    }
    rememberRequirements(
      state.task,
      prompt,
      verdict === "discuss" || verdict === "unknown" ? "discuss" : verdict,
      interpreted?.constraints ?? approval.constraints,
    );
    note += `\n\n${contractNote(state.task)}`;
    decision.recognition = recognition;
    decision.reasons = [...decision.reasons.slice(-18), recognitionNote];
    if (["approve", "revise"].includes(verdict))
      state.task.workDecision = structuredClone(decision);
    state.lastDecision = decision;
    return {
      config,
      relation: verdict,
      decision,
      phase: state.phase,
      note,
      inject: true,
    };
  }
  if (relation === "new") {
    state.task = null;
    state.lastDecision = null;
    state.phase = "idle";
  }
  const followUp = !!state.task && relation !== "new";
  if (!state.task) state.task = newTask(prompt);
  if (recoverFromConversation) state.task.contextRecovery = true;
  if (relation === "revise") {
    state.task.planVersion++;
    delete state.task.approvedVersion;
    delete state.task.plan;
    delete state.task.planEntryId;
  }
  const { decision, classification } = await decide({
    packageRoot,
    cwd,
    prompt,
    state,
    model,
    fetcher,
    semantic,
    relation: followUp ? relation : "new",
    interpretation: interpreted,
    explicitMode: mode,
  });
  if (recognition.source === "agent" && recognition.reason === "in_band")
    decision.intentPolicy = "contextual";
  if (relation === "uncertain") decision.executionIntent = "unclear";
  if (relation === "discuss") decision.executionIntent = "read-only";
  decision.recognition ??= recognition;
  decision.reasons = [
    ...decision.reasons.slice(-18),
    `recognition:${decision.recognition.source}/${decision.recognition.reason}`,
  ];
  state.task.autonomy ||= hasAutonomyGrant(prompt);
  const meta = extractExecutionMeta(prompt);
  if (meta.approvalRequired === "explicit") {
    state.task.autonomy = false;
    delete state.task.approvedVersion;
  }
  if (decision.taskType === "review" && decision.executionIntent === "unclear")
    decision.executionIntent = "read-only";
  decision.rigor = chooseRigor(
    { ...classification, executionIntent: decision.executionIntent },
    mode,
  );
  state.phase =
    decision.rigor === "strict" &&
    decision.executionIntent !== "read-only" &&
    !state.task.autonomy &&
    state.task.approvedVersion !== state.task.planVersion
      ? "planning"
      : "executing";
  if (state.task.autonomy && state.phase === "executing") {
    state.task.approvedVersion = state.task.planVersion;
    note =
      "## Autonomous task\nThe user authorized autonomous execution for this task. Plan, execute and verify within its scope without repeated approval requests. New tasks do not inherit this authorization.";
  }
  rememberRequirements(
    state.task,
    prompt,
    relation,
    interpreted?.constraints ?? [],
  );
  note += `\n\n${contractNote(state.task)}`;
  if (relation !== "discuss" && relation !== "uncertain")
    state.task.workDecision = structuredClone(decision);
  state.lastDecision = decision;
  state.lastPrompt = prompt;
  if (!followUp) state.onceMode = null;
  return {
    config,
    classification,
    relation:
      relation === "uncertain"
        ? "uncertain"
        : followUp
          ? relation === "response"
            ? "continue"
            : relation
          : "new",
    decision,
    phase: state.phase,
    note,
    inject: true,
  };
}
