import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

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
 * A manifest entry loads when EVERY declared dimension matches (v0.20):
 * AND across dimensions, OR within one. `{"tasks": ["architecture"],
 * "domains": ["database"]}` means task∈{architecture} AND domains∋database
 * — the previous ANY-match semantics loaded architecture+frontend too,
 * re-manufacturing exactly the policy noise this extension exists to
 * remove. An entry with no filters always loads.
 */
function manifestEntryMatches(entry, decision) {
  const tasks = Array.isArray(entry?.tasks) ? entry.tasks : [];
  const domains = Array.isArray(entry?.domains) ? entry.domains : [];
  const concerns = Array.isArray(entry?.concerns) ? entry.concerns : [];
  const taskOk = tasks.length === 0 || tasks.includes(decision?.taskType);
  const doms = decision?.domains ?? [];
  const domainOk =
    domains.length === 0 || domains.some((d) => doms.includes(d));
  const cons = decision?.concerns ?? [];
  const concernOk =
    concerns.length === 0 || concerns.some((c) => cons.includes(c));
  return taskOk && domainOk && concernOk;
}

/**
 * Resolve a manifest entry path UNDER its policy root (v0.20 P0).
 * A project manifest is untrusted input: `{"path": "../../secret.md"}`
 * used to escape .pi/policies and read arbitrary text into the system
 * prompt. Reject: absolute paths, non-.md, anything whose realpath is
 * not strictly inside the realpath of the policy root (symlink escape
 * included). Returns the resolved real path or null.
 */
function containedPolicyPath(base, rel) {
  if (typeof rel !== "string" || !rel) return null;
  if (isAbsolute(rel)) return null;
  if (!/\.md$/i.test(rel)) return null;
  let rootReal;
  let fullReal;
  try {
    rootReal = realpathSync(base);
    fullReal = realpathSync(resolve(base, rel));
  } catch {
    return null;
  }
  if (fullReal === rootReal) return null;
  if (!fullReal.startsWith(rootReal + sep)) return null;
  return fullReal;
}

export function loadProjectPolicies(cwd, config = {}, decision = null) {
  const maxFiles = Number(config.projectPolicyMaxFiles ?? 12);
  const maxBytes = Number(config.projectPolicyMaxBytes ?? 24000);
  const allowList = Array.isArray(config.projectPolicies)
    ? new Set(config.projectPolicies)
    : null;

  const result = [];
  const skipped = []; // [{id, reason}] — surfaced via /policy why
  const seen = new Set(); // nearest .pi/policies shadows ancestor duplicates
  let used = 0;

  const pushFile = (full, rel, opts = {}) => {
    if (result.length >= maxFiles || used >= maxBytes) {
      skipped.push({
        id: `project.${rel}`,
        reason: "dropped (project maxFiles/maxBytes reached)",
      });
      return false;
    }
    if (
      allowList &&
      allowList.size > 0 &&
      !allowList.has(rel) &&
      !allowList.has(basename(rel))
    )
      return true; // filtered out by config; keep scanning
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      return true;
    }
    if (size > maxBytes || used + size > maxBytes) {
      if (!opts.silentSkip) {
        skipped.push({
          id: `project.${rel}`,
          reason: "dropped (project byte budget)",
        });
      }
      return true;
    }
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
    // v0.20 P0: entry paths are UNTRUSTED — containment-checked before
    // any read (no .., no absolute, .md only, realpath inside the root).
    const manifestPath = join(base, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath, {});
      for (const [key, entry] of Object.entries(manifest ?? {})) {
        const rel = String(entry?.path ?? key).replaceAll("\\", "/");
        if (!manifestEntryMatches(entry, decision)) continue;
        const full = containedPolicyPath(base, rel);
        if (!full) {
          skipped.push({
            id: `project.${rel}`,
            reason:
              "rejected (path escapes .pi/policies, non-.md, or unresolvable)",
          });
          continue;
        }
        if (!pushFile(full, rel)) break;
      }
      continue; // manifest mode consumes this root entirely
    }
    // Directory mode: every .md file loads (pre-manifest behavior).
    for (const full of walkMarkdown(base, maxFiles * 2)) {
      const rel = relative(base, full).replaceAll("\\", "/");
      if (!pushFile(full, rel, { silentSkip: true })) break;
    }
  }

  return { policies: result, skipped };
}
export function composePolicies({
  packageRoot,
  decision,
  config,
  phase = "executing",
  projectPolicies = [],
}) {
  const manifest = loadManifest(packageRoot);
  const profile = loadProfile(packageRoot, decision.profile);

  // Order matters for both selection and budget truncation. Lower in the
  // list = lower priority; if the byte budget runs out we drop from the
  // tail first.
  //
  // v0.21 P2 priority: project policies sit right after core — a repo's
  // own constraints ("never touch schema in this project") are MORE
  // specific and more binding than generic model adaptation, so
  // model.minimax-* is dropped before they are. Full order:
  //   core > project > rigor/flow > concern > domain > profile > model
  const ordered = [
    "core.evidence-priority",
    "core.constraint-retention",
    "core.verification",
  ];
  // Project entries are pre-loaded objects; mark them with a reserved
  // prefix so the walk can resolve them without a manifest lookup.
  for (const pp of projectPolicies) ordered.push(`project:${pp.id}`);
  // v0.19 flow/rigor split: flow (how to work) derives from the task type,
  // rigor (how strict) from risk/intent. Profiles carry behaviors only.
  if (decision.flow) ordered.push(`flow.${decision.flow}`);
  if (decision.rigor === "quick") ordered.push("rigor.quick");
  if (decision.rigor === "standard") ordered.push("rigor.standard");
  if (decision.rigor === "strict") {
    ordered.push("behavior.tool-discipline");
    ordered.push(
      phase === "planning" ? "rigor.strict-plan" : "rigor.strict-execute",
    );
  }
  // Concerns (v0.18): cross-cutting policies load alongside domains and
  // never compete for domain slots.
  for (const concern of decision.concerns ?? []) {
    const id = `concern.${concern}`;
    if (manifest?.policies?.[id]) ordered.push(id);
  }
  for (const domain of decision.domains ?? []) {
    const id = `domain.${domain}`;
    if (manifest?.policies?.[id]) ordered.push(id);
  }
  for (const id of profile.policies ?? []) ordered.push(id);
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

  // ONE budget walk over built-ins and project entries alike (v0.21).
  const maxBytes = Number(config.policyMaxBytes ?? 24000);
  const projectById = new Map(
    projectPolicies.map((p) => [`project:${p.id}`, p]),
  );
  const loaded = [];
  const missing = []; // unresolvable ids (typo in includePolicies / manifest gap)
  const budgetDropped = [];
  const projectBudgetDropped = [];
  let used = 0;
  for (const id of ids) {
    const project = projectById.get(id);
    const policy = project ?? loadPolicyById(packageRoot, manifest, id);
    if (!policy) {
      missing.push(id);
      continue;
    }
    const size = Buffer.byteLength(policy.content, "utf8");
    if (used + size > maxBytes) {
      if (project) projectBudgetDropped.push(policy.id);
      else budgetDropped.push(id); // drop entirely, no partial truncation
      continue;
    }
    loaded.push(policy);
    used += size;
  }
  return {
    policies: loaded,
    truncated: budgetDropped,
    projectBudgetDropped,
    missing,
    builtInBytes: used,
  };
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
  // v0.21 P2: ONE budget walk interleaves project policies with built-ins
  // (priority: core > project > rigor/flow > concern > domain > profile >
  // model). Project candidates load under their OWN caps first (file count
  // + projectPolicyMaxBytes); the TOTAL policyMaxBytes is enforced by the
  // unified walk, so a repo's own constraints are dropped only after model
  // adaptation is — never before it.
  const { policies: projectCandidates, skipped: projectSkipped } =
    loadProjectPolicies(cwd, config, decision);
  const walk = composePolicies({
    packageRoot,
    decision,
    config,
    phase,
    projectPolicies: projectCandidates,
  });
  const isProject = (p) => p.id.startsWith("project.");
  const policies = walk.policies.filter((p) => !isProject(p));
  const projectPolicies = walk.policies.filter(isProject);
  const bytes = (list) =>
    list.reduce((n, p) => n + Buffer.byteLength(p.content, "utf8"), 0);
  const builtInBytes = bytes(policies);
  const projectBytes = bytes(projectPolicies);
  return {
    policies,
    projectPolicies,
    projectSkipped: [
      ...projectSkipped,
      ...walk.projectBudgetDropped.map((id) => ({
        id,
        reason: "dropped (unified byte budget)",
      })),
    ],
    truncated: walk.truncated,
    missing: walk.missing,
    builtInBytes,
    projectBytes,
  };
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
    `Rigor: ${decision.rigor}`,
    `Flow: ${decision.flow ?? "default"}`,
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
