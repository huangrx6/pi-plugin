// /policy command handler.
// Two entry points:
//   - With no args: open an interactive ctx.ui.select() picker covering
//     mode / profile in sequence.
//   - With args: parse subcommand and apply directly (scriptable / LLM-friendly).

import {
  formatConfig,
  formatDecision,
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
  { key: "auto", description: "按 prompt 内容自动路由 workflow（默认）" },
  { key: "quick", description: "轻量 workflow：Inspect → Change → Verify" },
  {
    key: "standard",
    description: "中等：Task Contract → Inspect → Plan → Execute → Verify",
  },
  { key: "strict", description: "plan + 等批准 + 分 wave 执行" },
  { key: "off", description: "完全关闭策略注入（含 model adaptation）" },
];

const PROFILE_OPTIONS = [
  { key: "auto", description: "按 taskType 自动选（默认）" },
  {
    key: "coding",
    description:
      "通用编码：execution discipline / minimal change / context hygiene",
  },
  { key: "debugging", description: "debugging 任务 + debug-first workflow" },
  {
    key: "documentation",
    description: "文档/注释：execution discipline + minimal change",
  },
  {
    key: "architecture",
    description: "架构/设计：execution discipline + tool discipline",
  },
  {
    key: "review",
    description: "代码审查：context hygiene + review-first workflow",
  },
  {
    key: "research",
    description: "调研：context hygiene + research-first workflow",
  },
];

const VALID_MODES = new Set(MODE_OPTIONS.map((o) => o.key));

function selectOptionLabel(options) {
  return options.map((o) => `${o.key} — ${o.description}`).join("\n");
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
    const choice = await ctx.ui.select(
      title,
      selectOptionLabel(options),
      options,
    );
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
    if (!trimmed) return runInteractiveSelector(state, ctx);

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

    if (action === "why") {
      notify(ctx, formatDecision(state.lastDecision, state.phase), "info");
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
      });
      const result = validateConfig({
        config: cfg,
        packageRoot,
      });
      notify(ctx, formatValidation(result), result.ok ? "info" : "warning");
      return;
    }

    if (action === "cancel") {
      state.phase = "idle";
      notify(ctx, "Pending strict plan cancelled.", "success");
      return;
    }

    if (action === "reset") {
      state.runtimeMode = null;
      state.runtimeProfile = null;
      state.onceMode = null;
      state.lastDecision = null;
      state.phase = "idle";
      notify(ctx, "Policy runtime overrides reset.", "success");
      return;
    }

    notify(
      ctx,
      "Usage: /policy [auto|quick|standard|strict|off|once <mode>|profile <name>|preview <prompt...>|diff <promptA> || <promptB>|history [N|clear-disk]|config|validate|status|why|cancel|reset]",
      "info",
    );
  };
}

/**
 * Interactive picker: walk through mode / profile in order, persist
 * any choices the user makes, fall back to notify() messages if the picker
 * UI is unavailable.
 */
async function runInteractiveSelector(state, ctx) {
  const mode = await pickOne(
    ctx,
    `Policy mode (current: ${state.runtimeMode ?? "auto"})`,
    MODE_OPTIONS,
  );
  if (mode) {
    state.runtimeMode = mode;
    state.onceMode = null;
    if (mode === "off") {
      state.phase = "idle";
    }
  }
  const profile = await pickOne(
    ctx,
    `Policy profile (current: ${state.runtimeProfile ?? "auto"})`,
    PROFILE_OPTIONS,
  );
  if (profile) state.runtimeProfile = profile;
  notify(
    ctx,
    `Policy: mode=${mode ?? "unchanged"}, profile=${profile ?? "unchanged"}`,
    "info",
  );
}
