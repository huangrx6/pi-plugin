import { canonicalizeTestSpec, hashCanonical } from "./canonical.ts";
import { parseCapabilityRegistry } from "./registry.ts";
import { validateTestSpecSchema } from "./schema-validator.ts";
import { validateTestSpecSemantics } from "./semantic-validator.ts";
import { validateFixtureIntegrity } from "./fixture-validator.ts";
import type { ValidationResult } from "./types.ts";

function buildResult(
  structural: ReturnType<typeof validateTestSpecSchema>,
  semanticIssues: ValidationResult["semanticIssues"],
): ValidationResult {
  const ok = !semanticIssues.some((entry) => entry.severity === "error");
  const canonical = ok ? canonicalizeTestSpec(structural.value!) : undefined;
  return {
    ok,
    schemaIssues: structural.issues,
    semanticIssues,
    ...(canonical ? { canonical, hash: hashCanonical(canonical) } : {}),
  };
}

function structuralFailure(structural: ReturnType<typeof validateTestSpecSchema>, registryIssues: ValidationResult["semanticIssues"]): ValidationResult {
  return {
    ok: false,
    schemaIssues: structural.issues,
    semanticIssues: registryIssues,
  };
}

export function validateTestSpec(input: unknown, registryInput: unknown): ValidationResult {
  const structural = validateTestSpecSchema(input);
  const registry = parseCapabilityRegistry(registryInput);
  if (!structural.value || !registry.registry) return structuralFailure(structural, registry.issues);
  return buildResult(structural, validateTestSpecSemantics(structural.value, registry.registry));
}

export async function validateTestSpecWithFixtures(input: unknown, registryInput: unknown, fixtureRoot: string): Promise<ValidationResult> {
  const structural = validateTestSpecSchema(input);
  const registry = parseCapabilityRegistry(registryInput);
  if (!structural.value || !registry.registry) return structuralFailure(structural, registry.issues);
  const semanticIssues = validateTestSpecSemantics(structural.value, registry.registry);
  const fixtureIssues = await validateFixtureIntegrity(structural.value, fixtureRoot);
  return buildResult(structural, [...semanticIssues, ...fixtureIssues]);
}
