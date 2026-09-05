// /policy command handler.
// Two entry points:
//   - With no args: open an interactive ctx.ui.select() picker covering
//     recent behavior first; mode/profile settings are secondary.
//   - With args: parse subcommand and apply directly (scriptable / LLM-friendly).

import { saveSelections } from "../../src/core/config-writer.js";
import { createAgentClassifier } from "./agent-classifier.js";
import { persistWorkflow } from "./workflow-store.js";
import { activityText, phaseText } from "./activity.js";
import { sanitizeTerminalText } from "./terminal.js";
import {
  formatConfig,
  formatDiff,
  formatHistory,
  formatPreview,
  formatStatusSummary,
  formatValidation,
} from "./format.js";
import {
  appendHistory,
  clearHistory,
  resolveHistoryPath,
} from "../../src/core/history-store.js";
import { modelKey, notify, parsePolicyCommand } from "./helpers.js";
import {
  buildEffectiveConfig,
  compareDecisions,
  preview,
  recordHistory,
  validateConfig,
} from "./state.js";

const MODE_OPTIONS = [
  { key: "auto", description: "根据任务自动选择（默认）" },
  { key: "quick", description: "快速检查、修改并验证" },
  {
    key: "standard",
    description: "明确任务后检查、计划、执行并验证",
  },
  { key: "strict", description: "先给计划，确认后分步执行" },
  { key: "off", description: "关闭策略注入和模型适配" },
];

const PROFILE_OPTIONS = [
  { key: "auto", description: "根据任务类型自动选择（默认）" },
  {
    key: "coding",
    description: "通用编码：持续执行、控制改动、管理上下文",
  },
  {
    key: "debugging",
    description: "排查行为预设：持续执行、控制改动、管理上下文；不改变任务类型",
  },
  {
    key: "documentation",
    description: "文档与注释：持续执行、控制改动",
  },
  {
    key: "architecture",
    description: "架构设计：持续执行、遵守工具契约",
  },
  {
    key: "review",
    description: "审查行为预设：管理上下文；不改变任务类型或执行权限",
  },
  {
    key: "research",
    description: "调研行为预设：管理上下文；不改变任务类型或执行权限",
  },
];

const VALID_MODES = new Set(MODE_OPTIONS.map((o) => o.key));

const RECOGNITION_OPTIONS = [
  {
    key: "agent",
    description: "复用当前 agent 模型与认证；每个任务回合额外调用一次模型",
  },
  {
    key: "endpoint",
    description: "使用全局配置的独立识别接口；适合固定低成本模型",
  },
  {
    key: "fallback",
    description: "先用规则，仅在低置信度时调用独立接口（旧兼容模式）",
  },
  { key: "off", description: "关闭模型识别，只使用本地规则；不产生模型调用" },
];

const COMMAND_HELP = `# Policy 命令说明

/policy
  打开可选择面板；日常操作优先使用这个入口。

/policy recognition agent
  复用当前 agent 模型识别任务意图；只改变当前运行，额外消耗一次模型调用。

/policy recognition endpoint
  使用全局配置的独立识别接口；接口、模型和凭证引用来自全局 config.json。

/policy recognition fallback|off
  fallback 仅在规则低置信度时请求独立接口；off 完全使用本地规则。

/policy save global|project
  global 保存模式、配置档和识别方式；project 只保存项目允许的模式与配置档。

/policy task | approve | new | cancel
  查看任务账本；批准当前版本计划；结束关联并让下一条成为新任务；取消待审批计划。

/policy auto|quick|standard|strict|off
  设置当前运行的策略严格度。off 同时清除当前任务状态。

/policy once <mode>
  仅让下一个新任务使用指定严格度；当前任务续作不会消耗它。

/policy profile <name>
  选择行为策略集合，不改变任务意图、严格度或执行权限。

/policy preview [--new] [--semantic] <prompt>
  预览策略，不推进任务；默认不调用模型，--semantic 才允许模型识别。

/policy diff <A> || <B>
  比较两条请求的离线路由结果。

/policy why | injected | status | config | validate | history [N]
  查看触发原因、注入原文、运行状态、有效配置、校验结果和最近历史。

/policy reset
  清除当前运行覆盖和任务状态，重新使用文件配置。`;

function selectOptionLabel(options) {
  // ui.select renders ONE OPTION PER LINE from a string[]. The previous
  // implementation joined everything into a single "\n"-separated string,
  // which the select widget iterated character-by-character (one glyph
  // per row) — pass an array of per-option labels instead.
  return options.map((o) => `${o.key} — ${o.description}`);
}

function parseSelectedKey(choice) {
  if (!choice) return null;
  // ctx.ui.select returns the display label (or the value when the
  // presentation doesn't differ); pick the leading key token.
  const text = String(choice).trim();
  return text.split(/\s+/)[0]?.toLowerCase() ?? null;
}

async function pickOne(ctx, title, options) {
  // ctx.ui.select signature varies across pi versions: some return the
  // selected value directly, others return the index, others return the
  // option object. Try select first; fall back to confirm() with a
  // numbered list if select isn't available or returns garbage.
  if (typeof ctx?.ui?.select !== "function") return null;
  try {
    const choice = await ctx.ui.select(title, selectOptionLabel(options));
    if (typeof choice === "string") return parseSelectedKey(choice);
    if (
      choice &&
      typeof choice === "object" &&
      typeof choice.key === "string"
    ) {
      return choice.key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the /policy command handler. Dependencies are injected so this module
 * has no import side effects on pi (and is trivial to unit-test).
 */
export function createCommandHandler({ packageRoot, getState, pi }) {
  async function policyCommand(args, ctx) {
    const state = getState();
    const trimmed = String(args ?? "").trim();
    if (!trimmed) {
      if (typeof ctx?.ui?.select !== "function") {
        notify(
          ctx,
          activityText(state.lastActivity) +
            `\n当前：${phaseText(state.phase)}`,
          "info",
        );
        return;
      }
      const title = sanitizeTerminalText(
        `${state.lastActivity?.summary ?? "策略 · 尚未处理请求"}\n${phaseText(state.phase)}`,
      );
      const choice = await ctx.ui.select(title, [
        "本次行为 — 原因、已注入要求、下一步",
        "任务与审批 — 查看账本、批准计划、开始新任务或取消计划",
        "设置与保存 — 调整模式、识别模型、配置档及持久化范围",
        "诊断 — 查看注入原文、状态、配置、校验与历史",
        "命令说明 — 查看全部文本命令、作用和注意事项",
      ]);
      if (choice?.startsWith("本次行为"))
        notify(
          ctx,
          activityText(state.lastActivity) +
            `\n当前：${phaseText(state.phase)}`,
          "info",
        );
      if (choice?.startsWith("任务与审批"))
        await runTaskSelector(state, ctx, policyCommand);
      if (choice?.startsWith("设置与保存"))
        await runSettingsSelector(state, ctx, policyCommand, packageRoot);
      if (choice?.startsWith("诊断"))
        await runDiagnosticsSelector(ctx, policyCommand);
      if (choice?.startsWith("命令说明")) notify(ctx, COMMAND_HELP, "info");
      return;
    }

    const { action, rest } = parsePolicyCommand(args);

    if (action === "recognition") {
      const selected = rest[0];
      if (!selected) {
        const cfg = buildEffectiveConfig({
          packageRoot,
          cwd: ctx?.cwd ?? process.cwd(),
          state,
        });
        notify(
          ctx,
          JSON.stringify(
            {
              configuration: cfg.semanticFallback,
              last: state.lastDecision?.recognition ?? null,
            },
            null,
            2,
          ),
          "info",
        );
        return;
      }
      if (
        !["agent", "endpoint", "primary", "fallback", "off"].includes(selected)
      ) {
        notify(
          ctx,
          "Usage: /policy recognition [agent|endpoint|primary|fallback|off]",
          "warning",
        );
        return;
      }
      state.runtimeRecognition =
        selected === "off"
          ? { enabled: false }
          : selected === "agent" || selected === "endpoint"
            ? { enabled: true, strategy: "primary", source: selected }
            : selected === "fallback"
              ? { enabled: true, strategy: "fallback", source: "endpoint" }
              : { enabled: true, strategy: selected };
      notify(
        ctx,
        `识别模式：${selected}。agent 复用当前模型，endpoint 使用独立接口；/policy save global 可保存。`,
        "success",
      );
      return;
    }

    if (action === "task") {
      notify(
        ctx,
        JSON.stringify(state.task ?? { task: null }, null, 2),
        "info",
      );
      return;
    }
    if (action === "new") {
      state.task = null;
      state.lastDecision = null;
      state.lastPrompt = null;
      state.phase = "idle";
      state.outcome = "idle";
      notify(ctx, "已清除当前任务关联，下一条请求将作为新任务。", "success");
      return;
    }
    if (action === "approve") {
      if (
        state.phase !== "awaiting_approval" ||
        !state.task?.plan ||
        state.task.plan.planVersion !== state.task.planVersion
      ) {
        notify(
          ctx,
          "没有可批准的当前版本计划。先完成计划，再审批。",
          "warning",
        );
        return;
      }
      state.task.approvedVersion = state.task.planVersion;
      state.task.authorizationSource = "user_command";
      state.phase = "executing";
      state.outcome = "approved";
      notify(ctx, "已批准当前版本计划。发送“继续”即可执行。", "success");
      return;
    }

    if (VALID_MODES.has(action)) {
      state.runtimeMode = action;
      state.onceMode = null;
      if (action === "off") {
        state.phase = "idle";
        state.task = null;
        state.lastDecision = null;
        state.lastPrompt = null;
      }
      notify(ctx, `Policy mode: ${action}`, "success");
      return;
    }

    if (action === "once") {
      const mode = (rest[0] ?? "").toLowerCase();
      if (!VALID_MODES.has(mode)) {
        notify(ctx, "Usage: /policy once quick|standard|strict|off", "warning");
        return;
      }
      state.onceMode = mode;
      notify(ctx, `Next task policy mode: ${mode}`, "success");
      return;
    }

    if (action === "profile") {
      const profile = (rest[0] ?? "").toLowerCase();
      if (!profile || !PROFILE_OPTIONS.some((o) => o.key === profile)) {
        notify(
          ctx,
          "Usage: /policy profile " +
            PROFILE_OPTIONS.map((o) => o.key).join("|"),
          "warning",
        );
        return;
      }
      state.runtimeProfile = profile;
      notify(ctx, `Policy profile: ${profile}`, "success");
      return;
    }

    if (action === "save") {
      try {
        const path = await saveSelections({
          cwd: ctx?.cwd ?? process.cwd(),
          scope: rest[0],
          mode: state.runtimeMode,
          profile: state.runtimeProfile,
          recognition: state.runtimeRecognition,
        });
        notify(ctx, `Policy settings saved: ${path}`, "success");
      } catch (error) {
        notify(ctx, error.message, "warning");
      }
      return;
    }
    if (action === "preview") {
      const previewArgs = [...rest];
      let newTaskPreview = false;
      let semanticPreview = false;
      while (["--new", "--semantic"].includes(previewArgs[0])) {
        const flag = previewArgs.shift();
        if (flag === "--new") newTaskPreview = true;
        if (flag === "--semantic") semanticPreview = true;
      }
      const rawPrompt = previewArgs.join(" ").trim();
      if (!rawPrompt) {
        notify(
          ctx,
          "Usage: /policy preview <prompt...>  (dry-run classification + policy composition for the given prompt)",
          "warning",
        );
        return;
      }
      try {
        const result = await preview({
          packageRoot,
          state: newTaskPreview ? null : state,
          semantic: semanticPreview,
          agentClassifier: createAgentClassifier(ctx),
          cwd: ctx?.cwd ?? process.cwd(),
          prompt: rawPrompt,
          model: ctx?.model ?? state.currentModel,
        });
        recordHistory(state, {
          source: "preview",
          prompt: rawPrompt,
          decision: result.decision,
        });
        if (result.config?.historyFile) {
          const path = resolveHistoryPath(
            result.config.historyFile,
            ctx?.cwd ?? process.cwd(),
          );
          if (path && state.history.length > 0) {
            const latest = state.history[state.history.length - 1];
            await appendHistory(path, latest);
          }
        }
        notify(ctx, formatPreview(result), "info");
      } catch (err) {
        notify(
          ctx,
          `preview failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return;
    }

    if (action === "diff") {
      const joined = rest.join(" ");
      const sepIdx = joined.indexOf("||");
      if (sepIdx === -1) {
        notify(
          ctx,
          "Usage: /policy diff <promptA> || <promptB>  (compare two prompts' routing decisions side by side)",
          "warning",
        );
        return;
      }
      const leftPrompt = joined.slice(0, sepIdx).trim();
      const rightPrompt = joined.slice(sepIdx + 2).trim();
      if (!leftPrompt || !rightPrompt) {
        notify(
          ctx,
          "Both prompts required: /policy diff <promptA> || <promptB>",
          "warning",
        );
        return;
      }
      try {
        const [left, right] = await Promise.all([
          preview({
            packageRoot,
            state,
            cwd: ctx?.cwd ?? process.cwd(),
            prompt: leftPrompt,
            model: ctx?.model ?? state.currentModel,
          }),
          preview({
            packageRoot,
            state,
            cwd: ctx?.cwd ?? process.cwd(),
            prompt: rightPrompt,
            model: ctx?.model ?? state.currentModel,
          }),
        ]);
        const differences = compareDecisions(left, right);
        notify(
          ctx,
          formatDiff({ leftPrompt, left, rightPrompt, right, differences }),
          "info",
        );
      } catch (err) {
        notify(
          ctx,
          `diff failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return;
    }

    if (action === "history") {
      if (rest[0] === "clear-disk") {
        const cfg = buildEffectiveConfig({
          packageRoot,
          cwd: ctx?.cwd ?? process.cwd(),
          state,
        });
        if (!cfg.historyFile) {
          notify(ctx, "No historyFile configured; nothing to clear.", "info");
          return;
        }
        const path = resolveHistoryPath(
          cfg.historyFile,
          ctx?.cwd ?? process.cwd(),
        );
        if (!path) {
          notify(ctx, "Could not resolve historyFile path.", "warning");
          return;
        }
        const result = await clearHistory(path);
        if (result.ok) {
          state.history = [];
          notify(ctx, `Cleared on-disk history at ${path}`, "success");
        } else {
          notify(ctx, `Failed to clear history: ${result.reason}`, "warning");
        }
        return;
      }
      const n = Number.parseInt(rest[0] ?? "5", 10);
      const limit = Number.isFinite(n) && n > 0 ? n : 5;
      notify(ctx, formatHistory(state.history, limit), "info");
      return;
    }

    if (action === "injected") {
      notify(ctx, state.lastActivity?.injected || "本轮没有注入指令。", "info");
      return;
    }
    if (action === "why") {
      notify(
        ctx,
        activityText(state.lastActivity) + `\n当前：${phaseText(state.phase)}`,
        "info",
      );
      return;
    }

    if (action === "status") {
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      notify(
        ctx,
        formatStatusSummary({
          config: cfg,
          phase: state.phase,
          outcome: state.outcome,
          task: state.task,
          recognition: state.lastDecision?.recognition,
          onceMode: state.onceMode,
          model: modelKey(ctx?.model ?? state.currentModel),
        }),
        "info",
      );
      return;
    }

    if (action === "config") {
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      notify(ctx, formatConfig(cfg), "info");
      return;
    }

    if (action === "validate") {
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
        raw: true,
      });
      const result = validateConfig({
        config: cfg,
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
      });
      notify(ctx, formatValidation(result), result.ok ? "info" : "warning");
      return;
    }

    if (action === "cancel") {
      state.phase = "idle";
      // v0.20: also drop the persisted awaiting state and the last prompt —
      // a bare follow-up after cancel must not resurrect the dead task.
      state.lastDecision = null;
      state.lastPrompt = null;
      state.task = null;
      // Persisted by the command wrapper using session identity.
      notify(ctx, "Pending strict plan cancelled.", "success");
      return;
    }

    if (action === "reset") {
      state.runtimeMode = null;
      state.runtimeProfile = null;
      state.runtimeRecognition = null;
      state.onceMode = null;
      state.lastDecision = null;
      state.lastPrompt = null;
      state.phase = "idle";
      state.task = null;
      // Persisted by the command wrapper using session identity.
      notify(ctx, "Policy runtime overrides reset.", "success");
      return;
    }

    notify(
      ctx,
      "Usage: /policy [recognition agent|endpoint|fallback|off|task|approve|new|auto|quick|standard|strict|off|once <mode>|profile <name>|save global|project|preview <prompt...>|diff <promptA> || <promptB>|history [N|clear-disk]|config|validate|status|why|injected|cancel|reset]",
      "info",
    );
  }
  return async (args, ctx) => {
    const state = getState();
    const before = JSON.stringify([
      state.phase,
      state.task,
      state.runtimeMode,
      state.runtimeProfile,
      state.onceMode,
      state.runtimeRecognition,
    ]);
    await policyCommand(args, ctx);
    if (
      JSON.stringify([
        state.phase,
        state.task,
        state.runtimeMode,
        state.runtimeProfile,
        state.onceMode,
        state.runtimeRecognition,
      ]) !== before
    ) {
      if (state.phase === "idle" && !state.lastDecision) state.task = null;
      await persistWorkflow({ pi, state, ctx, packageRoot });
    }
  };
}

/**
 * Interactive picker: walk through mode / profile in order, persist
 * any choices the user makes, fall back to notify() messages if the picker
 * UI is unavailable.
 */
async function runTaskSelector(state, ctx, runCommand) {
  const choice = await ctx.ui.select("任务与审批", [
    "查看任务账本 — 目标、要求、约束来源、计划及授权版本",
    "批准当前计划 — 只批准当前任务的当前计划版本",
    "开始新任务 — 清除当前任务关联；下一条请求重新识别",
    "取消待审批计划 — 清除当前任务及待审批状态",
  ]);
  if (choice?.startsWith("查看任务账本")) await runCommand("task", ctx);
  if (choice?.startsWith("批准当前计划")) await runCommand("approve", ctx);
  if (choice?.startsWith("开始新任务")) await runCommand("new", ctx);
  if (choice?.startsWith("取消待审批计划")) await runCommand("cancel", ctx);
}

async function runDiagnosticsSelector(ctx, runCommand) {
  const choice = await ctx.ui.select("策略诊断 · 只读操作", [
    "注入原文 — 查看最近实际追加给模型的完整指令",
    "运行状态 — 当前任务阶段、模型和最近识别来源",
    "有效配置 — 查看配置合并结果、来源及识别参数",
    "校验配置 — 检查结构、策略引用和项目配置边界",
    "最近历史 — 查看最近 5 条路由与阶段记录",
  ]);
  if (choice?.startsWith("注入原文")) await runCommand("injected", ctx);
  if (choice?.startsWith("运行状态")) await runCommand("status", ctx);
  if (choice?.startsWith("有效配置")) await runCommand("config", ctx);
  if (choice?.startsWith("校验配置")) await runCommand("validate", ctx);
  if (choice?.startsWith("最近历史")) await runCommand("history 5", ctx);
}

async function runSettingsSelector(state, ctx, runCommand, packageRoot) {
  const config = buildEffectiveConfig({
    packageRoot,
    cwd: ctx?.cwd ?? process.cwd(),
    state,
  });
  const recognition = config.semanticFallback?.enabled
    ? config.semanticFallback.source === "agent"
      ? "agent"
      : config.semanticFallback.strategy === "fallback"
        ? "fallback"
        : "endpoint"
    : "off";
  const choice = await ctx.ui.select("策略设置", [
    `模式 — 当前 ${config.mode}; 控制策略深度和审批流程`,
    `单次模式 — 当前 ${state.onceMode ?? "无"}; 仅作用于下一个新任务`,
    `意图识别 — 当前 ${recognition}; 选择当前模型、独立接口或本地规则`,
    `配置档 — 当前 ${config.profile}; 选择行为策略，不改变授权`,
    "保存到全局 — 保存当前选择，重启和其他项目继续使用",
    "保存到项目 — 只保存模式和配置档到当前项目，不保存模型接口",
  ]);
  if (choice?.startsWith("模式")) {
    const mode = await pickOne(
      ctx,
      `选择模式 · 当前 ${state.runtimeMode ?? "auto"}`,
      MODE_OPTIONS,
    );
    if (!mode) return;
    state.runtimeMode = mode;
    state.onceMode = null;
    if (mode === "off") {
      state.phase = "idle";
      state.task = null;
      state.lastDecision = null;
      state.lastPrompt = null;
    }
    notify(ctx, `策略模式已设为 ${mode}。`, "success");
    return;
  }
  if (choice?.startsWith("单次模式")) {
    const mode = await pickOne(ctx, "选择下一个新任务的单次模式", MODE_OPTIONS);
    if (mode) await runCommand(`once ${mode}`, ctx);
    return;
  }
  if (choice?.startsWith("意图识别")) {
    const selected = await pickOne(
      ctx,
      `选择识别方式 · 当前 ${recognition}`,
      RECOGNITION_OPTIONS,
    );
    if (selected) await runCommand(`recognition ${selected}`, ctx);
    return;
  }
  if (choice?.startsWith("配置档")) {
    const profile = await pickOne(
      ctx,
      `选择配置档 · 当前 ${state.runtimeProfile ?? "auto"}`,
      PROFILE_OPTIONS,
    );
    if (!profile) return;
    state.runtimeProfile = profile;
    notify(ctx, `策略配置档已设为 ${profile}。`, "success");
    return;
  }
  if (choice?.startsWith("保存到全局")) await runCommand("save global", ctx);
  if (choice?.startsWith("保存到项目")) await runCommand("save project", ctx);
}
