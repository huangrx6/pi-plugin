// /policy command handler.
// Two entry points:
//   - With no args: open an interactive ctx.ui.select() picker covering
//     recent behavior first; mode/profile settings are secondary.
//   - With args: parse subcommand and apply directly (scriptable / LLM-friendly).

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
  clearStrictState,
  resolveHistoryPath,
} from "../../src/core/history-store.js";
import { modelKey, notify, parsePolicyCommand } from "./helpers.js";
import {
  buildEffectiveConfig,
  compareDecisions,
  preview,
  recordHistory,
  resolveStrictStatePath,
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
    description: "故障排查：先复现和定位原因",
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
    description: "代码审查：优先检查问题与风险",
  },
  {
    key: "research",
    description: "调研：先收集并核对资料",
  },
];

const VALID_MODES = new Set(MODE_OPTIONS.map((o) => o.key));

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
export function createCommandHandler({ packageRoot, getState }) {
  return async function policyCommand(args, ctx) {
    const state = getState();
    const trimmed = String(args ?? "").trim();
    if (!trimmed) {
      if (typeof ctx?.ui?.select !== "function") {
        notify(ctx, activityText(state.lastActivity) + `\n当前：${phaseText(state.phase)}`, "info");
        return;
      }
      const title = sanitizeTerminalText(`${state.lastActivity?.summary ?? "策略 · 尚未处理请求"}\n${phaseText(state.phase)}`);
      const choice = await ctx.ui.select(title, [
        "本次行为 — 原因、已注入要求、下一步", "注入原文 — 查看实际追加的指令", "设置 — 调整模式与配置档",
      ]);
      if (choice?.startsWith("本次行为")) notify(ctx, activityText(state.lastActivity) + `\n当前：${phaseText(state.phase)}`, "info");
      if (choice?.startsWith("注入原文")) notify(ctx, state.lastActivity?.injected || "本轮没有注入指令。", "info");
      if (choice?.startsWith("设置")) await runSettingsSelector(state, ctx);
      return;
    }

    const { action, rest } = parsePolicyCommand(args);

    if (VALID_MODES.has(action)) {
      state.runtimeMode = action;
      state.onceMode = null;
      if (action === "off") {
        state.phase = "idle";
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

    if (action === "preview") {
      const rawPrompt = rest.join(" ").trim();
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
            appendHistory(path, latest).catch(() => {});
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
            cwd: ctx?.cwd ?? process.cwd(),
            prompt: leftPrompt,
            model: ctx?.model ?? state.currentModel,
          }),
          preview({
            packageRoot,
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
      notify(ctx, activityText(state.lastActivity) + `\n当前：${phaseText(state.phase)}`, "info");
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
      const cfg0 = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      const sPath0 = resolveStrictStatePath(cfg0, ctx?.cwd ?? process.cwd());
      if (sPath0) clearStrictState(sPath0).catch(() => {});
      notify(ctx, "Pending strict plan cancelled.", "success");
      return;
    }

    if (action === "reset") {
      state.runtimeMode = null;
      state.runtimeProfile = null;
      state.onceMode = null;
      state.lastDecision = null;
      state.lastPrompt = null;
      state.phase = "idle";
      const cfg1 = buildEffectiveConfig({
        packageRoot,
        cwd: ctx?.cwd ?? process.cwd(),
        state,
      });
      const sPath1 = resolveStrictStatePath(cfg1, ctx?.cwd ?? process.cwd());
      if (sPath1) clearStrictState(sPath1).catch(() => {});
      notify(ctx, "Policy runtime overrides reset.", "success");
      return;
    }

    notify(
      ctx,
      "Usage: /policy [auto|quick|standard|strict|off|once <mode>|profile <name>|preview <prompt...>|diff <promptA> || <promptB>|history [N|clear-disk]|config|validate|status|why|injected|cancel|reset]",
      "info",
    );
  };
}

/**
 * Interactive picker: walk through mode / profile in order, persist
 * any choices the user makes, fall back to notify() messages if the picker
 * UI is unavailable.
 */
async function runSettingsSelector(state, ctx) {
  const choice = await ctx.ui.select("策略设置", [
    `模式 — 当前 ${state.runtimeMode ?? "auto"}`,
    `配置档 — 当前 ${state.runtimeProfile ?? "auto"}`,
  ]);
  if (choice?.startsWith("模式")) {
    const mode = await pickOne(ctx, `选择模式 · 当前 ${state.runtimeMode ?? "auto"}`, MODE_OPTIONS);
    if (!mode) return;
    state.runtimeMode = mode;
    state.onceMode = null;
    if (mode === "off") state.phase = "idle";
    notify(ctx, `策略模式已设为 ${mode}。`, "success");
    return;
  }
  if (choice?.startsWith("配置档")) {
    const profile = await pickOne(ctx, `选择配置档 · 当前 ${state.runtimeProfile ?? "auto"}`, PROFILE_OPTIONS);
    if (!profile) return;
    state.runtimeProfile = profile;
    notify(ctx, `策略配置档已设为 ${profile}。`, "success");
  }
}
