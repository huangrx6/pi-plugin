import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { TestSpec, ValidationIssue } from "./types.ts";

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function contained(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export async function validateFixtureIntegrity(spec: TestSpec, fixtureRoot: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const root = resolve(fixtureRoot);
  const realRoot = await realpath(root).catch(() => root);
  await Promise.all(spec.fixtures.map(async (fixture, index) => {
    const path = resolve(root, fixture.path);
    if (isAbsolute(fixture.path) || !contained(path, root)) {
      issues.push({ code: "FIXTURE-001", path: `/fixtures/${index}/path`, severity: "error", message: "fixture path must remain inside the Test Spec directory" });
      return;
    }
    let realPath: string;
    try {
      realPath = await realpath(path);
    } catch (error) {
      issues.push({ code: "FIXTURE-003", path: `/fixtures/${index}/path`, severity: "error", message: `fixture cannot be read: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (!contained(realPath, realRoot)) {
      issues.push({ code: "FIXTURE-001", path: `/fixtures/${index}/path`, severity: "error", message: `fixture path must remain inside the Test Spec directory; it resolves to ${realPath}` });
      return;
    }
    try {
      const actual = await sha256File(realPath);
      if (actual.toLowerCase() !== fixture.digest.value.toLowerCase()) issues.push({ code: "FIXTURE-002", path: `/fixtures/${index}/digest/value`, severity: "error", message: `fixture digest mismatch for ${fixture.path}; actual SHA256 is ${actual}` });
    } catch (error) {
      issues.push({ code: "FIXTURE-003", path: `/fixtures/${index}/path`, severity: "error", message: `fixture cannot be read: ${error instanceof Error ? error.message : String(error)}` });
    }
  }));
  return issues;
}
