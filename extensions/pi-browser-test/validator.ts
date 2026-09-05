import { canonicalizeTestSpec, testSpecHash } from "./canonical.ts";
import { parseCapabilityRegistry } from "./registry.ts";
import { validateTestSpecSchema } from "./schema-validator.ts";
import { validateTestSpecSemantics } from "./semantic-validator.ts";
import { validateFixtureIntegrity } from "./fixture-validator.ts";
import type { ValidationResult } from "./types.ts";

export function validateTestSpec(input: unknown, registryInput: unknown): ValidationResult {
  const structural = validateTestSpecSchema(input);
  const registry = parseCapabilityRegistry(registryInput);
  if (!structural.value || !registry.registry) {
    return {
      ok: false,
      schemaIssues: structural.issues,
      semanticIssues: registry.issues,
    };
  }
  const semanticIssues = validateTestSpecSemantics(structural.value, registry.registry);
  const ok = !semanticIssues.some((entry) => entry.severity === "error");
  return {
    ok,
    schemaIssues: structural.issues,
    semanticIssues,
    ...(ok ? {
      canonical: canonicalizeTestSpec(structural.value),
      hash: testSpecHash(structural.value),
    } : {}),
  };
}

export async function validateTestSpecWithFixtures(input: unknown, registryInput: unknown, fixtureRoot: string): Promise<ValidationResult> {
  const result = validateTestSpec(input, registryInput);
  const structural = validateTestSpecSchema(input);
  if (!structural.value) return result;
  const fixtureIssues = await validateFixtureIntegrity(structural.value, fixtureRoot);
  const semanticIssues = [...result.semanticIssues, ...fixtureIssues];
  const ok = result.schemaIssues.length === 0 && !semanticIssues.some((entry) => entry.severity === "error");
  return {
    ...result,
    ok,
    semanticIssues,
    canonical: ok ? canonicalizeTestSpec(structural.value) : undefined,
    hash: ok ? testSpecHash(structural.value) : undefined,
  };
}
