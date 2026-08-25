import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

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
  return readJson(join(packageRoot, "policies", "manifest.json"), { policies: {} });
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
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxFiles) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, maxFiles, out);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(full);
  }
  return out;
}

export function loadProjectPolicies(cwd, config = {}) {
  const base = join(cwd, ".pi", "policies");
  const maxFiles = Number(config.projectPolicyMaxFiles ?? 12);
  const maxBytes = Number(config.projectPolicyMaxBytes ?? 24000);
  const allowList = Array.isArray(config.projectPolicies) ? new Set(config.projectPolicies) : null;

  const files = walkMarkdown(base, maxFiles * 2);
  const result = [];
  let used = 0;

  for (const full of files) {
    if (result.length >= maxFiles || used >= maxBytes) break;
    const rel = relative(base, full).replaceAll("\\", "/");
    if (allowList && allowList.size > 0 && !allowList.has(rel) && !allowList.has(basename(rel))) continue;
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > maxBytes || used + size > maxBytes) continue;
    try {
      const content = readText(full);
      result.push({ id: `project.${rel}`, source: `.pi/policies/${rel}`, content });
      used += size;
    } catch {
      // Ignore unreadable project policy files.
    }
  }

  return result;
}

export function composePolicies({ packageRoot, decision, config, phase = "executing" }) {
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
  if (decision.workflow === "quick") ordered.push("workflow.quick");
  if (decision.workflow === "standard") ordered.push("workflow.standard");
  if (decision.workflow === "strict") {
    ordered.push("behavior.tool-discipline");
    ordered.push(phase === "planning" ? "workflow.strict-plan" : "workflow.strict-execute");
  }
  for (const domain of decision.domains ?? []) {
    const id = `domain.${domain}`;
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
  return { policies: loaded, truncated };
}

export function renderPolicyBlock({ decision, policies, projectPolicies, phase, truncated = [] }) {
  const summary = [
    "# Active Policy Runtime",
    "",
    `Task type: ${decision.taskType}`,
    `Risk: ${decision.risk}`,
    `Workflow: ${decision.workflow}`,
    `Phase: ${phase}`,
    `Profile: ${decision.profile}`,
    `Gate: ${decision.gate}`,
    `Domains: ${(decision.domains ?? []).join(", ") || "none"}`,
    `Model policy: ${decision.modelPolicy ?? "default"}`,
    "",
    "The following policies are active for this turn. Treat them as execution constraints, not as user-visible output requirements unless a policy explicitly says so.",
  ];

  if (truncated.length > 0) {
    summary.push("", `> Note: ${truncated.length} policy(s) were dropped by the byte budget: ${truncated.join(", ")}. Increase "policyMaxBytes" or use "excludePolicies" to make room.`);
  }

  const chunks = [summary.join("\n")];
  for (const policy of [...policies, ...projectPolicies]) {
    chunks.push(`\n## Policy: ${policy.id}\nSource: ${policy.source}\n\n${policy.content}`);
  }
  return chunks.join("\n");
}
