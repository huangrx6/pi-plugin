// loader.js + config.js + validateConfig tests (policy composition).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  composeAllPolicies,
  composePolicies,
  loadProjectPolicies,
  projectPolicyRoots,
  renderPolicyBlock,
} from "../src/core/loader.js";
import { mergeConfig } from "../src/core/config.js";
import { validateConfig } from "../extensions/policy-engine/state.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("project policies load from examples/project", () => {
  const projectPolicies = loadProjectPolicies(
    join(root, "examples", "project"),
    { projectPolicyMaxFiles: 12, projectPolicyMaxBytes: 24000 },
  );
  assert.equal(projectPolicies.length, 2);
  assert.match(projectPolicies[0].content, /backward compatible/i);
  assert.match(projectPolicies[1].content, /observability/i);
});

test("mergeConfig deep-merges nested objects", () => {
  const merged = mergeConfig(
    { mode: "auto", profile: "auto", nested: { a: 1, b: 2 } },
    { mode: "strict", nested: { b: 99, c: 3 } },
    { includePolicies: ["behavior.execution-discipline"] },
  );
  assert.equal(merged.mode, "strict");
  assert.equal(merged.profile, "auto");
  assert.deepEqual(merged.nested, { a: 1, b: 99, c: 3 });
});

test("mergeConfig unions id-keyed object arrays (last wins)", () => {
  const merged = mergeConfig(
    {
      items: [
        { id: "x", v: 1 },
        { id: "y", v: 2 },
      ],
    },
    {
      items: [
        { id: "y", v: 22 },
        { id: "z", v: 3 },
      ],
    },
  );
  assert.equal(merged.items.length, 3);
  assert.deepEqual(
    merged.items.map((i) => i.id),
    ["x", "y", "z"],
  );
  assert.equal(merged.items.find((i) => i.id === "y").v, 22);
});

test("byte budget drops low-priority policies first", () => {
  const decision = {
    taskType: "coding",
    risk: "high",
    confidence: 0.9,
    executionIntent: "mutate",
    domains: ["database", "kubernetes"],
    rigor: "strict",
    profile: "coding",
    modelPolicy: "model.minimax-m3",
    reasons: [],
  };
  const tight = composePolicies({
    packageRoot: root,
    decision,
    config: { policyMaxBytes: 1500, excludePolicies: [], includePolicies: [] },
    phase: "planning",
  });
  assert.ok(tight.truncated.length > 0);
  // domain.kubernetes drops before core.* does.
  assert.ok(!tight.policies.some((p) => p.id === "domain.kubernetes"));
  assert.ok(tight.policies.some((p) => p.id === "core.evidence-priority"));
});

test("renderPolicyBlock surfaces the truncated list", () => {
  const block = renderPolicyBlock({
    decision: {
      taskType: "coding",
      risk: "low",
      confidence: 0.9,
      executionIntent: "mutate",
      domains: [],
      rigor: "quick",
      profile: "coding",
      modelPolicy: null,
      reasons: [],
    },
    policies: [],
    projectPolicies: [],
    phase: "executing",
    truncated: ["domain.database", "model.minimax-m3"],
  });
  assert.match(block, /domain\.database/);
  assert.match(block, /model\.minimax-m3/);
  assert.match(block, /byte budget/i);
});

test("validateConfig: clean baseline is ok", () => {
  const result = validateConfig({ config: {}, packageRoot: root });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("validateConfig: unknown include id is a warning", () => {
  const result = validateConfig({
    config: { includePolicies: ["totally.bogus"] },
    packageRoot: root,
  });
  assert.equal(result.ok, true);
  assert.ok(
    result.issues.some(
      (i) => i.severity === "warning" && i.message.includes("totally.bogus"),
    ),
  );
});

test("validateConfig: core.* ids always accepted", () => {
  const result = validateConfig({
    config: { includePolicies: ["core.evidence-priority"] },
    packageRoot: root,
  });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test("validateConfig: missing manifest path is an error", async () => {
  // Temp fixtures live in the OS temp dir (mkdtemp), never the package root.
  const fs = await import("node:fs/promises");
  const tmpDir = await fs.mkdtemp(join(tmpdir(), "pi-policy-validate-"));
  await fs.mkdir(join(tmpDir, "policies"), { recursive: true });
  await fs.writeFile(
    join(tmpDir, "policies", "manifest.json"),
    JSON.stringify({
      policies: { "ghost.policy": "policies/does-not-exist.md" },
    }),
  );
  const result = validateConfig({ config: {}, packageRoot: tmpDir });
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (i) =>
        i.severity === "error" &&
        i.message.includes("ghost.policy") &&
        i.message.includes("does-not-exist.md"),
    ),
  );
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("validateConfig: profile referencing unknown id is an error", async () => {
  const fs = await import("node:fs/promises");
  const tmpDir = await fs.mkdtemp(join(tmpdir(), "pi-policy-validate-"));
  await fs.mkdir(join(tmpDir, "profiles"), { recursive: true });
  await fs.writeFile(
    join(tmpDir, "profiles", "broken.json"),
    JSON.stringify({ policies: ["missing.policy"] }),
  );
  const result = validateConfig({ config: {}, packageRoot: tmpDir });
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some(
      (i) =>
        i.severity === "error" &&
        i.message.includes("broken.json") &&
        i.message.includes("missing.policy"),
    ),
  );
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// v0.17 unified budget: built-ins + project policies share ONE
// policyMaxBytes. Previously each list was capped independently, so the
// injected block could reach 2x the configured budget.
test("composeAllPolicies: total (built-in + project) never exceeds policyMaxBytes", async () => {
  const fs = await import("node:fs/promises");
  const projectDir = await fs.mkdtemp(join(tmpdir(), "pi-policy-budget-"));
  await fs.mkdir(join(projectDir, ".pi", "policies"), { recursive: true });
  await fs.writeFile(
    join(projectDir, ".pi", "policies", "big.md"),
    "X".repeat(2000),
  );

  const decision = {
    taskType: "coding",
    risk: "low",
    confidence: 0.9,
    executionIntent: "mutate",
    domains: [],
    rigor: "quick",
    profile: "coding",
    modelPolicy: null,
    reasons: [],
  };

  // Tight total budget: built-ins take most of it, the 2KB project file
  // must NOT be appended on top (the v0.16 bug this test pins).
  const config = {
    policyMaxBytes: 1500,
    projectPolicyMaxBytes: 24000,
    excludePolicies: [],
    includePolicies: [],
  };
  const result = composeAllPolicies({
    packageRoot: root,
    cwd: projectDir,
    decision,
    config,
    phase: "executing",
  });
  assert.ok(
    result.builtInBytes + result.projectBytes <= 1500,
    `total ${result.builtInBytes}+${result.projectBytes} must be <= 1500`,
  );
  assert.equal(result.projectPolicies.length, 0);

  // Comfortable budget: the project file loads within the REMAINING space.
  const roomy = composeAllPolicies({
    packageRoot: root,
    cwd: projectDir,
    decision,
    config: {
      policyMaxBytes: 24000,
      projectPolicyMaxBytes: 24000,
      excludePolicies: [],
      includePolicies: [],
    },
    phase: "executing",
  });
  assert.equal(roomy.projectPolicies.length, 1);
  assert.ok(roomy.builtInBytes + roomy.projectBytes <= 24000);

  await fs.rm(projectDir, { recursive: true, force: true });
});

// ---- v0.18-3: ancestor project policy discovery -------------------------

test("projectPolicyRoots walks up from cwd to the git root", async () => {
  const fs = await import("node:fs/promises");
  const repo = await fs.mkdtemp(join(tmpdir(), "pi-policy-ancestor-"));
  await fs.mkdir(join(repo, ".git"), { recursive: true });
  await fs.mkdir(join(repo, ".pi", "policies"), { recursive: true });
  await fs.mkdir(join(repo, "backend", "service-a"), { recursive: true });

  // From a nested cwd: only the repo root's .pi/policies exists → found.
  const roots = projectPolicyRoots(join(repo, "backend", "service-a"));
  assert.equal(roots.length, 1);
  assert.ok(roots[0].startsWith(repo));

  // Nested .pi takes nearest-first ordering.
  await fs.mkdir(join(repo, "backend", ".pi", "policies"), { recursive: true });
  const two = projectPolicyRoots(join(repo, "backend", "service-a"));
  assert.equal(two.length, 2);
  assert.ok(two[0].includes(join("backend", ".pi"))); // nearest first

  await fs.rm(repo, { recursive: true, force: true });
});

test("loadProjectPolicies discovers ancestor policies from a nested cwd", async () => {
  const fs = await import("node:fs/promises");
  const repo = await fs.mkdtemp(join(tmpdir(), "pi-policy-ancestor-"));
  await fs.mkdir(join(repo, ".git"), { recursive: true });
  await fs.mkdir(join(repo, ".pi", "policies"), { recursive: true });
  await fs.mkdir(join(repo, "backend", "service-a"), { recursive: true });
  await fs.writeFile(join(repo, ".pi", "policies", "root.md"), "# Root policy\n");

  const found = loadProjectPolicies(join(repo, "backend", "service-a"), {});
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "project.root.md");
  assert.match(found[0].content, /Root policy/);

  await fs.rm(repo, { recursive: true, force: true });
});

test("nearest .pi/policies shadows an ancestor's duplicate id", async () => {
  const fs = await import("node:fs/promises");
  const repo = await fs.mkdtemp(join(tmpdir(), "pi-policy-shadow-"));
  await fs.mkdir(join(repo, ".git"), { recursive: true });
  await fs.mkdir(join(repo, ".pi", "policies"), { recursive: true });
  await fs.mkdir(join(repo, "sub", ".pi", "policies"), { recursive: true });
  await fs.writeFile(join(repo, ".pi", "policies", "shared.md"), "ANCESTOR");
  await fs.writeFile(join(repo, "sub", ".pi", "policies", "shared.md"), "NEAREST");

  const found = loadProjectPolicies(join(repo, "sub"), {});
  assert.equal(found.length, 1);
  assert.equal(found[0].content, "NEAREST");

  await fs.rm(repo, { recursive: true, force: true });
});

// ---- v0.18-4: conditional project policies (manifest.json) --------------

test("manifest.json gates which project policies load per decision", async () => {
  const fs = await import("node:fs/promises");
  const repo = await fs.mkdtemp(join(tmpdir(), "pi-policy-manifest-"));
  const base = join(repo, ".pi", "policies");
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(join(base, "arch.md"), "ARCH POLICY");
  await fs.writeFile(join(base, "db.md"), "DB POLICY");
  await fs.writeFile(join(base, "always.md"), "ALWAYS POLICY");
  // Not listed in the manifest → never loads in manifest mode.
  await fs.writeFile(join(base, "unlisted.md"), "SHOULD NOT LOAD");
  await fs.writeFile(
    join(base, "manifest.json"),
    JSON.stringify({
      "arch-guide": { path: "arch.md", tasks: ["architecture"] },
      "db-guide": { path: "db.md", domains: ["database"] },
      "always": { path: "always.md" },
    }),
  );

  // architecture task: arch.md (tasks match) + always.md; db.md filtered out.
  const archDecision = { taskType: "architecture", domains: [], concerns: [] };
  const forArch = loadProjectPolicies(repo, {}, archDecision);
  assert.equal(forArch.length, 2);
  assert.ok(forArch.some((p) => p.content === "ARCH POLICY"));
  assert.ok(forArch.some((p) => p.content === "ALWAYS POLICY"));

  // database domain: db.md + always.md.
  const dbDecision = { taskType: "coding", domains: ["database"], concerns: [] };
  const forDb = loadProjectPolicies(repo, {}, dbDecision);
  assert.equal(forDb.length, 2);
  assert.ok(forDb.some((p) => p.content === "DB POLICY"));

  // unrelated decision: only the unconditional entry.
  const other = loadProjectPolicies(repo, {}, { taskType: "coding", domains: [], concerns: [] });
  assert.equal(other.length, 1);
  assert.equal(other[0].content, "ALWAYS POLICY");
  // unlisted.md never loaded in any mode.
  for (const list of [forArch, forDb, other]) {
    assert.ok(!list.some((p) => p.content === "SHOULD NOT LOAD"));
  }

  await fs.rm(repo, { recursive: true, force: true });
});
