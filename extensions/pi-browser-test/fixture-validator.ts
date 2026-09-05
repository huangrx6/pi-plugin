import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { TestSpec, ValidationIssue } from "./types.ts";

export async function validateFixtureIntegrity(spec: TestSpec, fixtureRoot: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const root = resolve(fixtureRoot);
  await Promise.all(spec.fixtures.map(async (fixture, index) => {
    const path = resolve(root, fixture.path);
    const outside = relative(root, path).startsWith("..") || isAbsolute(relative(root, path));
    if (isAbsolute(fixture.path) || outside) {
      issues.push({ code: "FIXTURE-001", path: `/fixtures/${index}/path`, severity: "error", message: "fixture path must remain inside the Test Spec directory" });
      return;
    }
    try {
      const content = await readFile(path);
      const actual = createHash("sha256").update(content).digest("hex");
      if (actual.toLowerCase() !== fixture.digest.value.toLowerCase()) issues.push({ code: "FIXTURE-002", path: `/fixtures/${index}/digest/value`, severity: "error", message: `fixture digest mismatch for ${fixture.path}; actual SHA256 is ${actual}` });
    } catch (error) {
      issues.push({ code: "FIXTURE-003", path: `/fixtures/${index}/path`, severity: "error", message: `fixture cannot be read: ${error instanceof Error ? error.message : String(error)}` });
    }
  }));
  return issues;
}
