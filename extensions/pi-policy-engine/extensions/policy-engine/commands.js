// /policy command handler.
// Two entry points:
//   - With no args: open an interactive ctx.ui.select() picker with the small
//     set of daily controls; diagnostics remain parameterized text commands.
//   - With args: parse subcommand and apply directly (scriptable / LLM-friendly).

import { saveSelections } from "../../src/core/config-writer.js";
import { globalConfigPath } from "../../src/core/paths.js";
import { persistWorkflow } from "./workflow-store.js";
import { activityText, phaseText } from "./activity.js";
import { sanitizeTerminalText } from "./terminal.js";
import { EXTENSION_VERSION } from "./version.js";
import {
  formatConfig,
  formatUsageSummary,
  formatDiff,
  formatHistory,
  formatPreview,
  formatStatusSummary,
  formatValidation,
} from "./format.js";
import {
  appendHistory,
  clearHistory,
  readHistory,
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

/**
 * Build the /policy command handler. Dependencies are injected so this module
 * has no import side effects on pi (and is trivial to unit-test).
 */
export function createCommandHandler({
  packageRoot,
  getState,
  pi,
  saveConfig = saveSelections,
}) {
  async function applyGlobalPreset(state, ctx, mode) {
    state.runtimeMode = mode;
    if (mode !== "off")
      state.runtimeRecognition = {
        enabled: true,
        source: "agent",
      };
    if (mode === "off") {
      state.phase = "idle";
      state.task = null;
      state.lastDecision = null;
      state.lastPrompt = null;
    }
    try {
      const path = await saveConfig({
        mode,
        recognition: mode === "off" ? null : state.runtimeRecognition,
      });
      notify(
        ctx,
        mode === "off"
          ? `策略已关闭并保存。配置：${path}`
          : `${mode === "strict" ? "谨慎处理" : "自动处理"}已启用并保存；当前模型将在用户消息显示后的 Working 阶段识别意图，再继续正式回答。配置：${path}`,
        "success",
      );
    } catch (error) {
      notify(
        ctx,
        `设置已在当前运行生效，但保存失败：${error.message}`,
        "warning",
      );
    }
  }

  // 0.36.1: recognition-context profile switching from the panel.
  // Three presets with payload-size explanations; selecting one saves
  // atomically to the global config (per-key overrides in the file
  // survive via config-writer's deeper context merge).
  const CONTEXT_PROFILE_ROWS = {
    minimal:
      "极简（推荐） — 只带语境：当前消息 + 最近对话 + 任务目标；负载 < 2k",
    standard: "标准 — 语境 + 最新 3 条需求原文；负载 3–6k",
    rich: "完整 — 语境 + 需求 + 约束 + 计划摘要；负载 8–15k",
  };

  function currentContextProfile(state, ctx) {
    const cfg = buildEffectiveConfig({
      packageRoot,
      cwd: ctx?.cwd ?? process.cwd(),
      state,
    });
    const profile = cfg.recognition?.context?.profile;
    return ["minimal", "standard", "rich"].includes(profile)
      ? profile
      : "minimal";
  }

  async function applyContextProfile(state, ctx, profile) {
    state.runtimeRecognition = {
      ...(state.runtimeRecognition ?? {}),
      enabled: true,
      source: "agent",
    };
    try {
      const path = await saveConfig({
        recognition: { context: { profile } },
      });
      notify(
        ctx,
        `识别负载已设为「${CONTEXT_PROFILE_ROWS[profile].split(" — ")[0]}」并保存，下一轮识别生效。配置：${path}`,
        "success",
      );
    } catch (error) {
      notify(ctx, `识别负载保存失败：${error.message}`, "warning");
    }
  }

  async function pickContextProfile(state, ctx) {
    const current = currentContextProfile(state, ctx);
    const title = `识别负载 · 当前：${CONTEXT_PROFILE_ROWS[current].split(" — ")[0]}
意图识别需要语境，不需要完整账本；档位只影响识别请求，不影响注入的策略`;
    const options = [
      ...Object.entries(CONTEXT_PROFILE_ROWS).map(
        ([key, row]) => `${row}${key === current ? "（当前）" : ""}`,
      ),
      "返回",
    ];
    const choice = await ctx.ui.select(sanitizeTerminalText(title), options);
    if (choice === undefined || choice === "返回") return; // silent cancel
    for (const [key, row] of Object.entries(CONTEXT_PROFILE_ROWS)) {
      if (choice === `${row}（当前）` || choice === row) {
        await applyContextProfile(state, ctx, key);
        return;
      }
    }
  }

  // 0.37.0: pick the recognition model from the host's configured
  // catalogue — expensive primaries can keep cheap preflight models.
  async function applyRecognitionModel(ctx, agentModel) {
    try {
      const path = await saveConfig({
        recognition: agentModel ? { agentModel } : { agentModel: null },
      });
      notify(
        ctx,
        agentModel
          ? `意图识别将使用 ${agentModel}（下一轮生效；主对话模型不变）。配置：${path}`
          : `意图识别将跟随主模型（下一轮生效）。配置：${path}`,
        "success",
      );
    } catch (error) {
      notify(ctx, `识别模型保存失败：${error.message}`, "warning");
    }
  }

  async function pickRecognitionModel(state, ctx) {
    const registry = ctx?.modelRegistry;
    const current = currentContextProfile; // noop reference guard
    void current;
    const configured = (() => {
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      return cfg.recognition?.agentModel ?? null;
    })();
    if (!registry || typeof registry.getAvailable !== "function") {
      notify(
        ctx,
        configured
          ? `当前识别模型：${configured}。当前宿主未提供模型列表，可用 /policy model <provider/model-id|auto> 直接设置。`
          : `意图识别当前跟随主模型。当前宿主未提供模型列表，可用 /policy model <provider/model-id|auto> 直接设置。`,
        "info",
      );
      return;
    }
    let models = [];
    try {
      models = registry.getAvailable() ?? [];
    } catch {
      models = [];
    }
    const rows = models
      .filter((model) => model?.provider && model?.id)
      .map(
        (model) =>
          `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`,
      );
    const options = [
      `跟随主模型（默认）— 主对话用什么，识别就用什么${configured ? "" : "（当前）"}`,
      ...rows.map(
        (row) =>
          `${row}${configured === row.split(" — ")[0] ? "（当前）" : ""}`,
      ),
      "返回",
    ];
    const choice = await ctx.ui.select(
      sanitizeTerminalText(
        `识别模型 · ${configured ?? "跟随主模型"}\n意图识别是每轮一次的小请求，可选用已配置的便宜模型；主对话模型不受影响`,
      ),
      options,
    );
    if (choice === undefined || choice === "返回") return;
    if (choice.startsWith("跟随主模型")) {
      await applyRecognitionModel(ctx, null);
      return;
    }
    const picked = choice
      .split(" — ")[0]
      .replace(/（当前）$/, "")
      .trim();
    await applyRecognitionModel(ctx, picked);
  }

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
      const options = [
        "查看本次状态 — 当前流程、判断方式和下一步",
        "自动处理（推荐）— 当前模型结合完整对话判断；选中后立即保存",
        "谨慎处理 — 所有修改先给计划再等待确认；选中后立即保存",
        "识别负载 — 意图识别带多少上下文；三档可选，选中后立即保存",
        "识别模型 — 识别用哪个模型；可选用已配置的便宜模型，选中后立即保存",
        "检查配置 — 显示个人配置位置并校验是否有效",
      ];
      if (state.phase === "awaiting_approval" && state.task?.plan)
        options.splice(1, 0, "批准当前计划 — 只批准当前任务的当前计划版本");
      if (state.task)
        options.splice(
          options.length - 1,
          0,
          "结束当前任务 — 清除任务关联；下一条请求重新开始",
        );
      options.push("关闭策略 — 停止策略注入并立即保存");
      const choice = await ctx.ui.select(title, options);
      if (choice?.startsWith("查看本次状态"))
        notify(
          ctx,
          activityText(state.lastActivity) +
            `\n当前：${phaseText(state.phase)}`,
          "info",
        );
      if (choice?.startsWith("批准当前计划"))
        await policyCommand("approve", ctx);
      if (choice?.startsWith("自动处理"))
        await applyGlobalPreset(state, ctx, "auto");
      if (choice?.startsWith("谨慎处理"))
        await applyGlobalPreset(state, ctx, "strict");
      if (choice?.startsWith("结束当前任务")) await policyCommand("new", ctx);
      if (choice?.startsWith("识别负载")) await pickContextProfile(state, ctx);
      if (choice?.startsWith("识别模型"))
        await pickRecognitionModel(state, ctx);
      if (choice?.startsWith("检查配置")) {
        const cfg = buildEffectiveConfig({
          packageRoot,
          cwd: ctx?.cwd ?? process.cwd(),
          state,
        });
        const checked = validateConfig({
          config: buildEffectiveConfig({
            packageRoot,
            cwd: ctx?.cwd ?? process.cwd(),
            state,
            raw: true,
          }),
          packageRoot,
          cwd: ctx?.cwd ?? process.cwd(),
        });
        notify(
          ctx,
          `运行版本：${EXTENSION_VERSION}\n个人配置：${globalConfigPath()}\n识别日志：${cfg.historyFile ? resolveHistoryPath(cfg.historyFile, ctx?.cwd ?? process.cwd()) : "未启用"}\n当前模式：${cfg.mode}；意图理解：${cfg.recognition?.enabled ? "当前模型（Working 阶段前置识别）" : "已关闭"}\n配置校验：${checked.ok ? "通过" : "存在问题，可用 /policy validate 查看详情"}`,
          checked.ok ? "info" : "warning",
        );
      }
      if (choice?.startsWith("关闭策略"))
        await applyGlobalPreset(state, ctx, "off");
      return;
    }

    const { action, rest } = parsePolicyCommand(args);

    if (action === "model") {
      const wantedRaw = (rest[0] ?? "").trim();
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      const current = cfg.recognition?.agentModel ?? null;
      if (!wantedRaw) {
        notify(
          ctx,
          `识别模型：${current ?? "跟随主模型"}\n用法: /policy model <provider/model-id|auto>`,
          "info",
        );
        return;
      }
      if (wantedRaw.toLowerCase() === "auto") {
        await applyRecognitionModel(ctx, null);
        return;
      }
      if (!/^[^/\s]+\/[^/\s]+$/.test(wantedRaw)) {
        notify(
          ctx,
          '模型需要 "provider/model-id" 格式，或用 auto 跟随主模型。',
          "warning",
        );
        return;
      }
      await applyRecognitionModel(ctx, wantedRaw);
      return;
    }
    if (action === "context") {
      const wanted = (rest[0] ?? "").toLowerCase();
      if (!["minimal", "standard", "rich"].includes(wanted)) {
        notify(
          ctx,
          `当前识别负载：${CONTEXT_PROFILE_ROWS[currentContextProfile(state, ctx)].split(" — ")[0]}\n用法: /policy context minimal|standard|rich`,
          "info",
        );
        return;
      }
      await applyContextProfile(state, ctx, wanted);
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

    // 0.38.0: direct mode commands are back — the escape hatches that
    // 0.29/0.33 removed from the panel. Losing them meant the only way
    // out of a misbehaving turn was two selector steps.
    const MODE_COMMANDS = new Set(["off", "auto", "strict", "quick", "standard"]);
    if (MODE_COMMANDS.has(action)) {
      await applyGlobalPreset(state, ctx, action);
      return;
    }
    if (action === "once") {
      const wanted = (rest[0] ?? "").toLowerCase();
      if (!MODE_COMMANDS.has(wanted)) {
        notify(
          ctx,
          "用法: /policy once off|auto|strict|quick|standard（仅下一轮生效，不保存）",
          "info",
        );
        return;
      }
      state.onceMode = wanted;
      notify(
        ctx,
        `下一轮将按「${wanted}」处理（仅此一轮，不改保存的配置）。`,
        "success",
      );
      return;
    }
    if (action === "usage") {
      const cfg = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      let entries = state.history ?? [];
      if (cfg.historyFile) {
        const path = resolveHistoryPath(
          cfg.historyFile,
          ctx?.cwd ?? process.cwd(),
        );
        if (path) {
          const disk = await readHistory(path, 500);
          if (Array.isArray(disk) && disk.length > 0) entries = disk;
        }
      }
      notify(ctx, formatUsageSummary(entries), "info");
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
      state.runtimeRecognition = null;
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
      "使用 /policy 打开操作面板。高级诊断保留：/policy why|injected|status|config|validate|history|preview|diff|reset",
      "info",
    );
  }
  return async (args, ctx) => {
    const state = getState();
    const before = JSON.stringify([
      state.phase,
      state.task,
      state.runtimeMode,
      state.runtimeRecognition,
    ]);
    await policyCommand(args, ctx);
    if (
      JSON.stringify([
        state.phase,
        state.task,
        state.runtimeMode,
        state.runtimeRecognition,
      ]) !== before
    ) {
      if (state.phase === "idle" && !state.lastDecision) state.task = null;
      await persistWorkflow({ pi, state, ctx, packageRoot });
    }
  };
}
