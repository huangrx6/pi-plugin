// Mutating tool/shell guard for pi-policy-engine.
//
// V0.3 design:
//   - shell patterns are categorized (file / git / package / k8s / disk).
//   - commands are split into segments respecting single/double quotes and
//     $(...) command substitution; each segment is matched independently.
//     This avoids false positives like `echo "rm -rf /"` being classified
//     as a deletion and false negatives like `kubectl apply -f x; rm tmp`
//     where the second segment is a real mutation.
//   - patterns are segment-anchored (^X) so they don't need the (^|[;&|])
//     prefix anymore — segments are already trimmed clean command heads.
//   - per-category enable/disable via config.guard.enabledCategories /
//     disabledCategories.

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
// Patterns are matched against an individual segment (segment-anchored).
const MUTATING_SHELL_PATTERNS = [
  // file ops
  { category: "file", label: "rm", pattern: /^rm\s+/i },
  { category: "file", label: "mv", pattern: /^mv\s+/i },
  { category: "file", label: "cp", pattern: /^cp\s+/i },
  { category: "file", label: "mkdir", pattern: /^mkdir\s+/i },
  { category: "file", label: "touch", pattern: /^touch\s+/i },
  { category: "file", label: "chmod", pattern: /^chmod\s+/i },
  { category: "file", label: "chown", pattern: /^chown\s+/i },
  { category: "file", label: "sed -i", pattern: /^sed\s+-i\b/i },
  { category: "file", label: "perl -pi", pattern: /^perl\s+-p?i\b/i },
  { category: "file", label: "redirect", pattern: /(?:^|[^&])>{1,2}\s*[^&]/ },
  { category: "file", label: "tee", pattern: /^tee\s+/i },

  // git
  {
    category: "git",
    label: "git commit/add/push/reset/...",
    pattern: /^git\s+(add|commit|push|reset|checkout|switch|merge|rebase|clean|stash)\b/i,
  },

  // package managers
  {
    category: "package",
    label: "npm/pnpm/yarn/bun install|add|remove|...",
    pattern: /^(?:npm|pnpm|yarn|bun)\s+(install|add|remove|uninstall|update|upgrade)\b/i,
  },
  { category: "package", label: "pip install", pattern: /^pip3?\s+install\b/i },
  {
    category: "package",
    label: "apt/yum/dnf install|remove|...",
    pattern: /^(?:apt|apt-get|yum|dnf)\s+(install|remove|upgrade|update)\b/i,
  },
  {
    category: "package",
    label: "brew install|uninstall|upgrade",
    pattern: /^brew\s+(install|uninstall|upgrade)\b/i,
  },

  // k8s / helm
  {
    category: "k8s",
    label: "kubectl apply|delete|patch|...",
    pattern:
      /^kubectl\s+(apply|delete|patch|edit|scale|rollout|set|create|replace|label|annotate)\b/i,
  },
  {
    category: "k8s",
    label: "helm install|upgrade|uninstall|rollback",
    pattern: /^helm\s+(install|upgrade|uninstall|rollback)\b/i,
  },

  // docker (still under "package" — shared dependency-management bucket)
  {
    category: "package",
    label: "docker build/run/rm/...",
    pattern: /^docker\s+(build|run|rm|rmi|push|tag)\b/i,
  },
  {
    category: "package",
    label: "docker compose up|down|...",
    pattern: /^docker\s+compose\s+(up|down|build|pull|push|restart)\b/i,
  },

  // disk / destructive
  { category: "disk", label: "mkfs", pattern: /^mkfs\.\w+/i },
  { category: "disk", label: "dd of=", pattern: /^dd\s+.*\bof=/i },
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
 * Split a shell command into ordered segments separated by `&&`, `||`, `;`,
 * and `|`. Quotes (single/double) and `$(...)` substitution are tracked so
 * that splitters inside them are ignored. Returns trimmed, non-empty
 * segments; leading/trailing whitespace per segment is preserved for
 * pattern anchoring.
 */
export function splitShellSegments(command) {
  const text = String(command ?? "");
  const segments = [];
  let current = "";
  let quote = null; // null | "'" | '"'
  let sub = 0; // $(...) nesting depth, treated as opaque

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (sub > 0) {
      current += ch;
      if (ch === "(") sub++;
      else if (ch === ")") sub--;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "$" && next === "(") {
      sub = 1;
      current += ch;
      continue;
    }
    // Splitters only outside quotes / substitutions.
    if (
      (ch === "&" && next === "&") ||
      (ch === "|" && next === "|") ||
      ch === ";" ||
      ch === "|"
    ) {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = "";
      if (ch === "&" || ch === "|") i++; // skip second char of && / ||
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments;
}

/**
 * Match a segment against the mutation pattern table. Returns the first hit
 * (category + label) or null. Patterns are segment-anchored.
 */
function matchSegment(segment) {
  for (const entry of MUTATING_SHELL_PATTERNS) {
    if (entry.pattern.test(segment)) return entry;
  }
  return null;
}

/**
 * Find the first mutating segment in a command. Returns
 * `{ category, label, segment }` or null. `segment` is the offending slice
 * (useful for diagnostics).
 *
 * After matching plain segments we also probe `$(...)` substitution
 * contents — a command like `echo $(rm -rf /tmp)` is a real deletion even
 * though the segment header is `echo`. We do shallow extraction (one level);
 * deeply nested `$(rm $(echo /tmp))` is out of scope and remains a known
 * limitation, matching the project's "conservative regex" posture.
 */
export function findMutatingShell(command) {
  for (const segment of splitShellSegments(command)) {
    const hit = matchSegment(segment);
    if (hit) return { ...hit, segment };
    const subMatches = segment.matchAll(/\$\(([^()]*)\)/g);
    for (const m of subMatches) {
      const subHit = matchSegment(m[1]);
      if (subHit) return { ...subHit, segment: `$(...) → ${m[1]}` };
    }
  }
  return null;
}

export function isMutatingShell(
  command,
  enabledCategories = new Set(ALL_CATEGORIES),
) {
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
      reason:
        "Policy Engine: strict workflow is awaiting approval; file mutation is blocked.",
    };
  }

  if (gate === "hard" && toolName === "bash") {
    const enabled = resolveEnabledCategories(gate, configGuard);
    const command = event?.input?.command ?? "";
    const hit = findMutatingShell(command);
    if (hit && enabled.has(hit.category)) {
      return {
        block: true,
        reason: `Policy Engine: strict workflow is awaiting approval; mutating shell command is blocked by hard gate [${hit.category}: ${hit.label}]. Segment: \`${hit.segment.slice(0, 120)}\``,
        category: hit.category,
        label: hit.label,
        segment: hit.segment,
      };
    }
  }

  return { block: false };
}

export function isApprovalPrompt(prompt) {
  const text = String(prompt ?? "").trim().toLowerCase();
  if (!text) return false;
  if (
    /(不批准|先别执行|不要执行|别执行|修改计划|调整计划|重新计划|继续分析|先分析|stop|hold|reject|revise)/i.test(
      text,
    )
  )
    return false;

  const strong =
    /^(批准|通过|执行|开始执行|可以执行|继续执行|approve|approved|proceed|go ahead|do it)(?:[，,。.!！\s]|$)/i;
  if (strong.test(text)) return true;

  return /^(继续|开始吧|可以|就这样)[。.!！\s]*$/i.test(text);
}

export function isPlanRevisionPrompt(prompt) {
  const text = String(prompt ?? "").trim().toLowerCase();
  return /(不批准|先别执行|不要执行|修改计划|调整计划|重新计划|revise|change the plan|hold|stop)/i.test(
    text,
  );
}

export const __test = {
  ALL_CATEGORIES,
  MUTATING_SHELL_PATTERNS,
  resolveEnabledCategories,
  splitShellSegments,
  matchSegment,
};
