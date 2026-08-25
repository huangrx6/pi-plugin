import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(path) {
  return readFileSync(path, "utf8").trim();
}

export function loadManifest(packageRoot) {
  return readJson(join(packageRoot, "policies", "manifest.json"), {
    policies: {},
  });
}

export function loadProfile(packageRoot, id) {
  const file = join(packageRoot, "profiles", `${id}.json`);
  return readJson(file, { id, policies: [] });
}

export function loadPolicyById(packageRoot, manifest, id) {
  const rel = manifest?.policies?.[id];
  if (!rel) return null;
  const full = resolve(packageRoot, rel);
  try {
    return {
      id,
      source: rel,
      content: readText(full),
    };
  } catch {
    return null;
  }
}

function walkMarkdown(dir, maxFiles, out = []) {
  if (!existsSync(dir) || out.length >= maxFiles) return out;
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, maxFiles, out);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Discover .pi/policies directories from cwd upward (v0.18). Nearest
 * first; the walk stops after the first ancestor containing .git (the
 * project root, checked INCLUSIVELY — its .pi/policies is collected).
 * Without this, starting pi in repo/backend/service-a never saw
 * repo/.pi/policies.
 */
export function projectPolicyRoots(cwd) {
  const roots = [];
  let cur = resolve(String(cwd ?? "."));
  for (;;) {
    const base = join(cur, ".pi", "policies");
    if (existsSync(base)) roots.push(base);
    if (existsSync(join(cur, ".git"))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots; // nearest first
}

/**
 * A manifest entry loads when ANY of its filters matches the decision —
 * tasks containing taskType, domains/concerns intersecting the decision's.
 * An entry with no filters always loads.
 */
function manifestEntryMatches(entry, decision) {
  const tasks = Array.isArray(entry?.tasks) ? entry.tasks : [];
  const domains = Array.isArray(entry?.domains) ? entry.domains : [];
  const concerns = Array.isArray(entry?.concerns) ? entry.concerns : [];
  if (tasks.length === 0 && domains.length === 0 && concerns.length === 0) {
    return true;
  }
  if (decision?.taskType && tasks.includes(decision.taskType)) return true;
  const doms = decision?.domains ?? [];
  if (domains.some((d) => doms.includes(d))) return true;
  const cons = decision?.concerns ?? [];
  if (concerns.some((c) => cons.includes(c))) return true;
  return false;
}

export function loadProjectPolicies(cwd, config = {}, decision = null) {
  const maxFiles = Number(config.projectPolicyMaxFiles ?? 12);
  const maxBytes = Number(config.projectPolicyMaxBytes ?? 24000);
  const allowList = Array.isArray(config.projectPolicies)
    ? new Set(config.projectPolicies)
    : null;

  const result = [];
  const seen = new Set(); // nearest .pi/policies shadows ancestor duplicates
  let used = 0;

  const pushFile = (full, rel) => {
    if (result.length >= maxFiles || used >= maxBytes) return false;
    if (
      allowList &&
      allowList.size > 0 &&
      !allowList.has(rel) &&
      !allowList.has(basename(rel))
    )
      return true; // filtered out; keep scanning
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      return true;
    }
    if (size > maxBytes || used + size > maxBytes) return true;
    try {
      const content = readText(full);
      const id = `project.${rel}`;
      if (seen.has(id)) return true; // shadowed by a nearer root
      seen.add(id);
      result.push({
        id,
        source: `.pi/policies/${rel}`,
        content,
      });
      used += size;
      return true;
    } catch {
      return true; // Ignore unreadable project policy files.
    }
  };

  for (const base of projectPolicyRoots(cwd)) {
    // Conditional mode (v0.18): a manifest.json in .pi/policies gates
    // which files load for THIS decision. Files not listed in the manifest
    // are not loaded — a 30-file project stays quiet.
    const manifestPath = join(base, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath, {});
      for (const [key, entry] of Object.entries(manifest ?? {})) {
        const rel = String(entry?.path ?? key).replaceAll("\\", "/");
        if (!manifestEntryMatches(entry, decision)) continue;
        if (!pushFile(join(base, rel), rel)) break;
      }
      continue; // manifest mode consumes this root entirely
    }
    // Directory mode: every .md file loads (pre-manifest behavior).
    for (const full of walkMarkdown(base, maxFiles * 2)) {
      const rel = relative(base, full).replaceAll("\\", "/");
      if (!pushFile(full, rel)) break;
    }
  }

  return result;
}
export function composePolicies({
  packageRoot,
  decision,
  config,
  phase = "executing",
}) {
  const manifest = loadManifest(packageRoot);
  const profile = loadProfile(packageRoot, decision.profile);

  // Order matters for both selection and budget truncation. Lower in the
  // list = lower priority; if the byte budget runs out we drop from the
  // tail first (project -> model -> domain -> workflow -> profile -> core).
  const ordered = [
    "core.evidence-priority",
    "core.constraint-retention",
    "core.verification",
    ...(profile.policies ?? []),
  ];
  // If the profile already carries a workflow.* policy (e.g. debugging →
  // debug-first, review → review-first), skip the generic workflow policy
  // for this decision — injecting both was pure context noise (v0.13).
  const profileHasWorkflow = (profile.policies ?? []).some((id) =>
    id.startsWith("workflow."),
  );
  if (!profileHasWorkflow) {
    if (decision.workflow === "quick") ordered.push("workflow.quick");
    if (decision.workflow === "standard") ordered.push("workflow.standard");
  }
  if (decision.workflow === "strict") {
    ordered.push("behavior.tool-discipline");
    ordered.push(
      phase === "planning" ? "workflow.strict-plan" : "workflow.strict-execute",
    );
  }
  for (const domain of decision.domains ?? []) {
    const id = `domain.${domain}`;
    if (manifest?.policies?.[id]) ordered.push(id);
  }
  // Concerns (v0.18): cross-cutting policies load alongside domains and
  // never compete for domain slots.
  for (const concern of decision.concerns ?? []) {
    const id = `concern.${concern}`;
    if (manifest?.policies?.[id]) ordered.push(id);
  }
  if (decision.modelPolicy) ordered.push(decision.modelPolicy);
  for (const id of config.includePolicies ?? []) ordered.push(id);

  // Apply include/exclude to the selected set, preserving order.
  const excludeSet = new Set(config.excludePolicies ?? []);
  const ids = [];
  const seen = new Set();
  for (const id of ordered) {
    if (excludeSet.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  // Load and apply a byte budget. Project policies participate in the budget
  // *after* built-ins: built-ins are always tried first.
  const maxBytes = Number(config.policyMaxBytes ?? 24000);
  const loaded = [];
  let used = 0;
  for (const id of ids) {
    const policy = loadPolicyById(packageRoot, manifest, id);
    if (!policy) continue;
    const size = Buffer.byteLength(policy.content, "utf8");
    if (used + size > maxBytes) continue; // drop entirely, do not partial-truncate
    loaded.push(policy);
    used += size;
  }
  const truncated = ids.filter((id) => !loaded.some((p) => p.id === id));
  return { policies: loaded, truncated, builtInBytes: used };
}

/**
 * Compose built-in AND project policies under ONE total byte budget
 * (v0.17). Previously the two lists were capped independently, so the
 * injected block could reach policyMaxBytes + projectPolicyMaxBytes —
 * /policy preview reported only the built-in share, hiding the overflow.
 * Now: built-ins load first (priority order), project policies get
 * min(projectPolicyMaxBytes, policyMaxBytes - builtInBytes).
 */
export function composeAllPolicies({
  packageRoot,
  cwd,
  decision,
  config,
  phase = "executing",
}) {
  const { policies, truncated, builtInBytes } = composePolicies({
    packageRoot,
    decision,
    config,
    phase,
  });
  const total = Number(config.policyMaxBytes ?? 24000);
  const remaining = Math.max(0, total - builtInBytes);
  const projectCap = Math.min(
    Number(config.projectPolicyMaxBytes ?? 24000),
    remaining,
  );
  const projectPolicies = loadProjectPolicies(
    cwd,
    {
      ...config,
      projectPolicyMaxBytes: projectCap,
    },
    decision,
  );
  const projectBytes = projectPolicies.reduce(
    (n, p) => n + Buffer.byteLength(p.content, "utf8"),
    0,
  );
  return { policies, projectPolicies, truncated, builtInBytes, projectBytes };
}

export function renderPolicyBlock({
  decision,
  policies,
  projectPolicies,
  phase,
  truncated = [],
}) {
  const summary = [
    "# Active Policy Runtime",
    "",
    `Task type: ${decision.taskType}`,
    `Risk: ${decision.risk}`,
    `Workflow: ${decision.workflow}`,
    `Phase: ${phase}`,
    `Profile: ${decision.profile}`,
    `Domains: ${(decision.domains ?? []).join(", ") || "none"}`,
    `Concerns: ${(decision.concerns ?? []).join(", ") || "none"}`,
    `Model policy: ${decision.modelPolicy ?? "default"}`,
    "",
    "The following policies are active for this turn. Treat them as execution constraints, not as user-visible output requirements unless a policy explicitly says so.",
  ];

  if (truncated.length > 0) {
    summary.push(
      "",
      `> Note: ${truncated.length} policy(s) were dropped by the byte budget: ${truncated.join(", ")}. Increase "policyMaxBytes" or use "excludePolicies" to make room.`,
    );
  }

  const chunks = [summary.join("\n")];
  for (const policy of [...policies, ...projectPolicies]) {
    chunks.push(
      `\n## Policy: ${policy.id}\nSource: ${policy.source}\n\n${policy.content}`,
    );
  }
  return chunks.join("\n");
}
