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
          `个人配置：${globalConfigPath()}\n识别日志：${cfg.historyFile ? resolveHistoryPath(cfg.historyFile, ctx?.cwd ?? process.cwd()) : "未启用"}\n当前模式：${cfg.mode}；意图理解：${cfg.recognition?.enabled ? "当前模型（Working 阶段前置识别）" : "已关闭"}\n配置校验：${checked.ok ? "通过" : "存在问题，可用 /policy validate 查看详情"}`,
          checked.ok ? "info" : "warning",
        );
      }
      if (choice?.startsWith("关闭策略"))
        await applyGlobalPreset(state, ctx, "off");
      return;
    }

    const { action, rest } = parsePolicyCommand(args);

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
