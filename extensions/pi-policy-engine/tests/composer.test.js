// loader.js + config.js + validateConfig tests (policy composition).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  composePolicies,
  loadProjectPolicies,
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
    { items: [{ id: "x", v: 1 }, { id: "y", v: 2 }] },
    { items: [{ id: "y", v: 22 }, { id: "z", v: 3 }] },
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
    workflow: "strict",
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
      workflow: "quick",
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
