// Mutating tool/shell guard for pi-policy-engine.
//
// V0.2 design: shell patterns are categorized (file / git / package / k8s / network /
// disk). Each category can be independently enabled/disabled via config:
//   guard: {
//     enabledCategories: ["file", "git", "package", "k8s", "network", "disk"]
//   }
// Any category not listed is treated as disabled. Default = all enabled when gate is
// "hard"; nothing is blocked when gate is "soft" or "off" except for direct mutation
// tools, which are always blocked while strict approval is pending.

const DIRECT_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "patch",
  "replace",
  "delete_file",
  "move_file",
]);

const MUTATING_TOOL_PATTERNS = [
  /(^|[_-])(write|edit|patch|delete|remove|rename|move|apply)([_-]|$)/i,
];

// Each entry: { category, label, pattern }.
// Categories: file, git, package, k8s, network, disk.
const MUTATING_SHELL_PATTERNS = [
  // file ops
  { category: "file", label: "rm", pattern: /(^|[;&|]\s*)rm\s+/i },
  { category: "file", label: "mv", pattern: /(^|[;&|]\s*)mv\s+/i },
  { category: "file", label: "cp", pattern: /(^|[;&|]\s*)cp\s+/i },
  { category: "file", label: "mkdir", pattern: /(^|[;&|]\s*)mkdir\s+/i },
  { category: "file", label: "touch", pattern: /(^|[;&|]\s*)touch\s+/i },
  { category: "file", label: "chmod", pattern: /(^|[;&|]\s*)chmod\s+/i },
  { category: "file", label: "chown", pattern: /(^|[;&|]\s*)chown\s+/i },
  { category: "file", label: "sed -i", pattern: /\bsed\s+-i\b/i },
  { category: "file", label: "perl -pi", pattern: /\bperl\s+-p?i\b/i },
  { category: "file", label: "redirect", pattern: /(^|[^>])>{1,2}\s*[^&]/ },
  { category: "file", label: "tee", pattern: /\btee\s+/i },

  // git
  { category: "git", label: "git commit/add/push/reset/...", pattern: /\bgit\s+(add|commit|push|reset|checkout|switch|merge|rebase|clean|stash)\b/i },

  // package managers
  { category: "package", label: "npm/pnpm/yarn/bun install|add|remove|...", pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|upgrade)\b/i },
  { category: "package", label: "pip install", pattern: /\bpip(?:3)?\s+install\b/i },
  { category: "package", label: "apt/yum/dnf install|remove|...", pattern: /\b(apt|apt-get|yum|dnf)\s+(install|remove|upgrade|update)\b/i },
  { category: "package", label: "brew install|uninstall|upgrade", pattern: /\bbrew\s+(install|uninstall|upgrade)\b/i },

  // k8s / helm
  { category: "k8s", label: "kubectl apply|delete|patch|...", pattern: /\bkubectl\s+(apply|delete|patch|edit|scale|rollout|set|create|replace|label|annotate)\b/i },
  { category: "k8s", label: "helm install|upgrade|uninstall|rollback", pattern: /\bhelm\s+(install|upgrade|uninstall|rollback)\b/i },

  // docker
  { category: "package", label: "docker build/run/rm/...", pattern: /\bdocker\s+(build|run|rm|rmi|push|tag)\b/i },
  { category: "package", label: "docker compose up|down|...", pattern: /\bdocker\s+compose\s+(up|down|build|pull|push|restart)\b/i },

  // disk / destructive (intentionally last so the matcher reports a category
  // even when a more specific one would have matched).
  { category: "disk", label: "mkfs", pattern: /\bmkfs\.\w+/i },
  { category: "disk", label: "dd of=", pattern: /\bdd\s+.*\bof=/i },
];

const ALL_CATEGORIES = ["file", "git", "package", "k8s", "network", "disk"];

function resolveEnabledCategories(gate, configGuard) {
  if (gate === "off") return new Set();
  // Direct mutation tools are always blocked during pendingApproval regardless
  // of which shell categories are enabled.
  if (gate === "soft") return new Set(); // soft gate does not use shell categories
  // hard gate: union of default (all) + explicit additions - explicit removals.
  const cfg = configGuard ?? {};
  const enabled = new Set(ALL_CATEGORIES);
  if (Array.isArray(cfg.enabledCategories)) {
    enabled.clear();
    for (const c of cfg.enabledCategories) enabled.add(String(c));
  }
  if (Array.isArray(cfg.disabledCategories)) {
    for (const c of cfg.disabledCategories) enabled.delete(String(c));
  }
  return enabled;
}

export function isDirectMutationTool(toolName) {
  const name = String(toolName ?? "").toLowerCase();
  if (DIRECT_MUTATION_TOOLS.has(name)) return true;
  return MUTATING_TOOL_PATTERNS.some((re) => re.test(name));
}

/**
 * Returns the first matching shell pattern entry, or null.
 * Lets callers report *which* category/label was hit instead of just "mutating".
 */
export function findMutatingShell(command) {
  const text = String(command ?? "");
  for (const entry of MUTATING_SHELL_PATTERNS) {
    if (entry.pattern.test(text)) return entry;
  }
  return null;
}

export function isMutatingShell(command, enabledCategories = new Set(ALL_CATEGORIES)) {
  const hit = findMutatingShell(command);
  if (!hit) return false;
  return enabledCategories.has(hit.category);
}

export function shouldBlockTool(event, gate, pendingApproval, configGuard) {
  if (!pendingApproval || gate === "off") return { block: false };

  const toolName = String(event?.toolName ?? "").toLowerCase();
  if (isDirectMutationTool(toolName)) {
    return {
      block: true,
      reason: "Policy Engine: strict workflow is awaiting approval; file mutation is blocked.",
    };
  }

  if (gate === "hard" && toolName === "bash") {
    const enabled = resolveEnabledCategories(gate, configGuard);
    const command = event?.input?.command ?? "";
    const hit = findMutatingShell(command);
    if (hit && enabled.has(hit.category)) {
      return {
        block: true,
        reason: `Policy Engine: strict workflow is awaiting approval; mutating shell command is blocked by hard gate [${hit.category}: ${hit.label}].`,
        category: hit.category,
        label: hit.label,
      };
    }
  }

  return { block: false };
}

export function isApprovalPrompt(prompt) {
  const text = String(prompt ?? "").trim().toLowerCase();
  if (!text) return false;
  if (/(不批准|先别执行|不要执行|别执行|修改计划|调整计划|重新计划|继续分析|先分析|stop|hold|reject|revise)/i.test(text)) return false;

  const strong = /^(批准|通过|执行|开始执行|可以执行|继续执行|approve|approved|proceed|go ahead|do it)(?:[，,。.!！\s]|$)/i;
  if (strong.test(text)) return true;

  return /^(继续|开始吧|可以|就这样)[。.!！\s]*$/i.test(text);
}

export function isPlanRevisionPrompt(prompt) {
  const text = String(prompt ?? "").trim().toLowerCase();
  return /(不批准|先别执行|不要执行|修改计划|调整计划|重新计划|revise|change the plan|hold|stop)/i.test(text);
}

export const __test = {
  ALL_CATEGORIES,
  MUTATING_SHELL_PATTERNS,
  resolveEnabledCategories,
};
