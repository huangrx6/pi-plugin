import { contractIndex, schemaAtPointer } from "./registry.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  AssertionSource,
  CapabilityCall,
  CapabilityContract,
  CapabilityInvocation,
  CapabilityRegistry,
  Fixture,
  JsonValue,
  Predicate,
  SchemaNode,
  TestSpec,
  ValidationIssue,
  ValueExpression,
} from "./types.ts";

const EXPECTED_REQUIRED = new Set([
  "EQUALS", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUAL",
  "LESS_THAN", "LESS_THAN_OR_EQUAL", "CONTAINS", "NOT_CONTAINS", "MATCHES",
]);
const NUMBER_OPERATORS = new Set(["GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL"]);
const STRING_OPERATORS = new Set(["MATCHES"]);
const BOOLEAN_OPERATORS = new Set(["IS_TRUE", "IS_FALSE"]);
const FORBIDDEN_IMPLEMENTATION_KEYS = new Set([
  "resolverversionid", "resolverhash", "locator", "backend", "browser", "url",
  "environmentid", "environmentfingerprint", "managementmode", "conformancestatus",
]);
const FORBIDDEN_RISK_KEYS = new Set(["risk", "policy", "skipapproval"]);
const FORBIDDEN_CODE_KEYS = new Set([
  "script", "javascript", "typescript", "eval", "callback", "function",
  "functionbody", "shell", "sql", "expression", "arbitraryexpression",
]);
const SECRET_KEYS = /(?:password|passwd|token|cookie|authorization|storage.?state|secret|api.?key)/i;

function add(issues: ValidationIssue[], code: string, path: string, message: string, severity: "error" | "warning" = "error"): void {
  issues.push({ code, path, severity, message });
}

function walk(value: JsonValue, path: string, visit: (key: string, value: JsonValue, path: string) => void): void {
  if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${path}/${index}`, visit));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      visit(key, child, childPath);
      walk(child, childPath, visit);
    }
  }
}

function expressions(value: unknown, path: string, out: Array<{ expression: ValueExpression; path: string }>): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, "literal") || Object.hasOwn(object, "fixtureRef") || Object.hasOwn(object, "stepOutputRef")) {
      out.push({ expression: value as ValueExpression, path });
      return;
    }
    for (const [key, child] of Object.entries(object)) expressions(child, `${path}/${key}`, out);
  } else value.forEach((child, index) => expressions(child, `${path}/${index}`, out));
}

function literalType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function schemaTypes(schema: SchemaNode | undefined): string[] {
  if (!schema) return [];
  if (schema["x-pi-valueKind"]) return [schema["x-pi-valueKind"]];
  if (Array.isArray(schema.type)) return schema.type;
  if (schema.type) return [schema.type];
  if (Object.hasOwn(schema, "const")) return [literalType(schema.const!)];
  if (schema.enum) return [...new Set(schema.enum.map(literalType))];
  return [];
}

function compatible(actual: string[], expected: string[]): boolean {
  if (!actual.length || !expected.length) return true;
  return actual.some((type) => expected.includes(type) || (type === "integer" && expected.includes("number")));
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return isDeepStrictEqual(left, right);
}

function validateLiteralAgainstSchema(value: JsonValue, schema: SchemaNode | undefined, path: string, issues: ValidationIssue[]): void {
  if (!schema) return;
  const actual = [literalType(value)];
  const expected = schemaTypes(schema);
  if (!compatible(actual, expected)) {
    add(issues, "TS-006", path, `literal type ${actual[0]} is incompatible with contract type ${expected.join("|") || "unknown"}`);
    return;
  }
  if (Object.hasOwn(schema, "const") && !sameJson(value, schema.const!)) add(issues, "TS-006", path, "literal does not equal the contract const value");
  if (schema.enum && !schema.enum.some((candidate) => sameJson(value, candidate))) add(issues, "TS-006", path, "literal is outside the contract enum");
  if (Array.isArray(value) && schema.items) value.forEach((entry, index) => validateLiteralAgainstSchema(entry, schema.items, `${path}/${index}`, issues));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) add(issues, "TS-006", `${path}/${required}`, "required literal object property is missing");
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (!childSchema && schema.additionalProperties === false) add(issues, "TS-006", `${path}/${key}`, "literal object property is not allowed by the contract");
      else validateLiteralAgainstSchema(child, childSchema ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined), `${path}/${key}`, issues);
    }
  }
}

function expressionTypes(
  expression: ValueExpression,
  fixtures: Map<string, Fixture>,
  steps: Map<string, CapabilityInvocation>,
  contracts: Map<string, CapabilityContract>,
): string[] {
  if ("literal" in expression) return [literalType(expression.literal)];
  if ("fixtureRef" in expression) {
    const kind = fixtures.get(expression.fixtureRef)?.kind;
    return kind === "TEXT" ? ["string"] : kind === "JSON" ? ["object"] : kind ? [kind] : [];
  }
  const source = steps.get(expression.stepOutputRef.stepId);
  if (!source) return [];
  const contract = contracts.get(`${source.capability.capabilityId}\0${source.capability.contractVersionId}`);
  return schemaTypes(contract && schemaAtPointer(contract.outputSchema, expression.stepOutputRef.path));
}

function validateUnique(spec: TestSpec, issues: ValidationIssue[]): void {
  const groups: Array<[string, Array<[string, string]>]> = [
    ["actorId", spec.actors.map((v, i) => [v.actorId, `/actors/${i}/actorId`])],
    ["fixtureId", spec.fixtures.map((v, i) => [v.fixtureId, `/fixtures/${i}/fixtureId`])],
    ["preconditionId", spec.preconditions.map((v, i) => [v.preconditionId, `/preconditions/${i}/preconditionId`])],
    ["assertionId", spec.assertions.map((v, i) => [v.assertionId, `/assertions/${i}/assertionId`])],
    ["stepId", [...spec.setup.map((v, i) => [v.stepId, `/setup/${i}/stepId`] as [string, string]), ...spec.steps.map((v, i) => [v.stepId, `/steps/${i}/stepId`] as [string, string]), ...spec.cleanup.map((v, i) => [v.stepId, `/cleanup/${i}/stepId`] as [string, string])]],
  ];
  for (const [name, entries] of groups) {
    const seen = new Set<string>();
    for (const [id, path] of entries) {
      if (seen.has(id)) add(issues, "TS-001", path, `${name} must be unique: ${id}`);
      seen.add(id);
    }
  }
}

function validateRefs(spec: TestSpec, issues: ValidationIssue[], sanctionedSecretKeys: ReadonlySet<string>): void {
  const actorIds = new Set(spec.actors.map((v) => v.actorId));
  const fixtureIds = new Set(spec.fixtures.map((v) => v.fixtureId));
  walk(spec as unknown as JsonValue, "", (key, value, path) => {
    if (key === "actorRef" && typeof value === "string" && !actorIds.has(value)) add(issues, "TS-002", path, `unknown actorRef: ${value}`);
    if (key === "fixtureRef" && typeof value === "string" && !fixtureIds.has(value)) add(issues, "TS-003", path, `unknown fixtureRef: ${value}`);
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (FORBIDDEN_IMPLEMENTATION_KEYS.has(normalized)) add(issues, "TS-013", path, `${key} belongs to a downstream implementation object`);
    if (FORBIDDEN_CODE_KEYS.has(normalized)) add(issues, "TS-013", path, `${key} would embed executable or arbitrary expression content`);
    if (FORBIDDEN_RISK_KEYS.has(normalized)) add(issues, "TS-014", path, `${key} cannot lower or decide execution risk in a Test Spec`);
    if (SECRET_KEYS.test(normalized) && !sanctionedSecretKeys.has(path)) add(issues, "TS-015", path, `${key} may contain secret material and is forbidden in a Test Spec`);
    if (typeof value === "string" && /^(?:Bearer\s+|Basic\s+)[A-Za-z0-9+/._=-]+$/i.test(value)) add(issues, "TS-015", path, "raw authorization material is forbidden in a Test Spec");
  });
}

// TS-015 key scanning treats input keys declared by the referenced Capability
// Contract as sanctioned business vocabulary, so fields such as `tokenCount`
// or `cookieConsent` validate when the contract owns them. Nested keys inside
// Literal payloads are never sanctioned, and raw `Bearer`/`Basic` material
// stays forbidden everywhere (enforced in validateRefs).
function sanctionedSecretKeyPaths(spec: TestSpec, contracts: Map<string, CapabilityContract>): Set<string> {
  const sanctioned = new Set<string>();
  const collect = (call: CapabilityCall, path: string) => {
    const contract = contracts.get(`${call.capability.capabilityId}\0${call.capability.contractVersionId}`);
    if (!contract) return;
    for (const name of Object.keys(call.input)) {
      if (Object.hasOwn(contract.inputSchema.properties ?? {}, name)) sanctioned.add(`${path}/input/${name}`);
    }
  };
  spec.setup.forEach((call, index) => collect(call, `/setup/${index}`));
  spec.steps.forEach((call, index) => collect(call, `/steps/${index}`));
  spec.cleanup.forEach((call, index) => collect(call, `/cleanup/${index}`));
  spec.preconditions.forEach((entry, index) => {
    if (entry.type === "CAPABILITY_ASSERTION") collect(entry.probe, `/preconditions/${index}/probe`);
  });
  spec.assertions.forEach((entry, index) => {
    if (entry.source.type === "CAPABILITY_RESULT") collect(entry.source.probe, `/assertions/${index}/source/probe`);
  });
  return sanctioned;
}

function validateReferenceOrder(spec: TestSpec, issues: ValidationIssue[]): void {
  const check = (value: unknown, path: string, available: Set<string>) => {
    const found: Array<{ expression: ValueExpression; path: string }> = [];
    expressions(value, path, found);
    for (const item of found) if ("stepOutputRef" in item.expression && !available.has(item.expression.stepOutputRef.stepId)) add(issues, "TS-004", `${item.path}/stepOutputRef/stepId`, `step output is unavailable at this lifecycle point: ${item.expression.stepOutputRef.stepId}`);
  };
  const setupAvailable = new Set<string>();
  spec.preconditions.forEach((value, index) => check(value, `/preconditions/${index}`, new Set()));
  spec.setup.forEach((value, index) => { check(value, `/setup/${index}`, setupAvailable); setupAvailable.add(value.stepId); });
  const stepAvailable = new Set(setupAvailable);
  spec.steps.forEach((value, index) => { check(value, `/steps/${index}`, stepAvailable); stepAvailable.add(value.stepId); });
  spec.assertions.forEach((value, index) => {
    check(value, `/assertions/${index}`, stepAvailable);
    if (value.source.type === "STEP_OUTPUT" && !stepAvailable.has(value.source.stepId)) add(issues, "TS-004", `/assertions/${index}/source/stepId`, `unknown completed step: ${value.source.stepId}`);
  });
  spec.cleanup.forEach((value, index) => check(value, `/cleanup/${index}`, stepAvailable));
}

function validateCall(
  call: CapabilityCall,
  path: string,
  role: "action" | "probe",
  fixtures: Map<string, Fixture>,
  steps: Map<string, CapabilityInvocation>,
  contracts: Map<string, CapabilityContract>,
  issues: ValidationIssue[],
): CapabilityContract | undefined {
  const key = `${call.capability.capabilityId}\0${call.capability.contractVersionId}`;
  const contract = contracts.get(key);
  if (!contract) { add(issues, "TS-005", `${path}/capability`, `contract not found: ${call.capability.capabilityId}@${call.capability.contractVersionId}`); return; }
  if (role === "action" && contract.kind !== "ACTION") add(issues, "TS-011", `${path}/capability`, "setup, steps and cleanup should use an ACTION capability", "warning");
  if (role === "probe" && contract.kind !== "QUERY") add(issues, "TS-011", `${path}/capability`, "precondition and assertion probes must use a QUERY capability");
  if (role === "probe" && (contract.sideEffect !== "NONE" || contract.externalEffect !== "NONE")) add(issues, "TS-012", `${path}/capability`, "probe capability must have sideEffect=NONE and externalEffect=NONE");
  const inputSchema = contract.inputSchema;
  for (const required of inputSchema.required ?? []) if (!Object.hasOwn(call.input, required)) add(issues, "TS-006", `${path}/input/${required}`, "required capability input is missing");
  if (inputSchema.additionalProperties === false) for (const name of Object.keys(call.input)) if (!inputSchema.properties?.[name]) add(issues, "TS-006", `${path}/input/${name}`, "input is not declared by the capability contract");
  for (const [name, expression] of Object.entries(call.input)) {
    const propertySchema = inputSchema.properties?.[name];
    const expected = schemaTypes(propertySchema);
    const actual = expressionTypes(expression, fixtures, steps, contracts);
    if (!compatible(actual, expected)) add(issues, "TS-006", `${path}/input/${name}`, `value type ${actual.join("|") || "unknown"} is incompatible with contract type ${expected.join("|") || "unknown"}`);
    if ("literal" in expression) validateLiteralAgainstSchema(expression.literal, propertySchema, `${path}/input/${name}/literal`, issues);
  }
  return contract;
}

function validateExpressionOutputPaths(
  spec: TestSpec,
  steps: Map<string, CapabilityInvocation>,
  contracts: Map<string, CapabilityContract>,
  issues: ValidationIssue[],
  ambiguousStepIds: ReadonlySet<string>,
): void {
  const found: Array<{ expression: ValueExpression; path: string }> = [];
  expressions(spec, "", found);
  for (const item of found) {
    if (!("stepOutputRef" in item.expression)) continue;
    if (ambiguousStepIds.has(item.expression.stepOutputRef.stepId)) continue;
    const reference = item.expression.stepOutputRef;
    const step = steps.get(reference.stepId);
    const contract = step && contracts.get(`${step.capability.capabilityId}\0${step.capability.contractVersionId}`);
    if (contract && !schemaAtPointer(contract.outputSchema, reference.path)) add(issues, "TS-007", `${item.path}/stepOutputRef/path`, `output path does not exist in the capability contract: ${reference.path}`);
  }
}

function sourceSchema(
  source: AssertionSource,
  path: string,
  steps: Map<string, CapabilityInvocation>,
  contracts: Map<string, CapabilityContract>,
  issues: ValidationIssue[],
  ambiguousStepIds: ReadonlySet<string>,
): SchemaNode | undefined {
  if (source.type === "STEP_OUTPUT") {
    if (ambiguousStepIds.has(source.stepId)) return undefined;
    const step = steps.get(source.stepId);
    const contract = step && contracts.get(`${step.capability.capabilityId}\0${step.capability.contractVersionId}`);
    const schema = contract && schemaAtPointer(contract.outputSchema, source.path);
    if (contract && !schema) add(issues, "TS-007", `${path}/path`, `output path does not exist in the capability contract: ${source.path}`);
    return schema;
  }
  const contract = contracts.get(`${source.probe.capability.capabilityId}\0${source.probe.capability.contractVersionId}`);
  const schema = contract && schemaAtPointer(contract.outputSchema, source.path);
  if (contract && !schema) add(issues, "TS-007", `${path}/path`, `output path does not exist in the capability contract: ${source.path}`);
  return schema;
}

function validatePredicate(
  predicate: Predicate,
  schema: SchemaNode | undefined,
  path: string,
  issues: ValidationIssue[],
  expectedTypes: string[] = [],
): void {
  const needsExpected = EXPECTED_REQUIRED.has(predicate.operator);
  const unexpectedExpected = !needsExpected && Object.hasOwn(predicate, "expected");
  if (needsExpected && !Object.hasOwn(predicate, "expected")) add(issues, "TS-009", `${path}/expected`, `${predicate.operator} requires expected`);
  if (unexpectedExpected) add(issues, "TS-009", `${path}/expected`, `${predicate.operator} must not provide expected`);
  const types = schemaTypes(schema);
  if (NUMBER_OPERATORS.has(predicate.operator) && !compatible(types, ["number", "integer"])) add(issues, "TS-008", `${path}/operator`, `${predicate.operator} requires a numeric source`);
  if (STRING_OPERATORS.has(predicate.operator) && !compatible(types, ["string"])) add(issues, "TS-008", `${path}/operator`, `${predicate.operator} requires a string source`);
  if (BOOLEAN_OPERATORS.has(predicate.operator) && !compatible(types, ["boolean"])) add(issues, "TS-008", `${path}/operator`, `${predicate.operator} requires a boolean source`);
  if (predicate.expected && !unexpectedExpected && !["CONTAINS", "NOT_CONTAINS"].includes(predicate.operator) && !compatible(expectedTypes, types)) add(issues, "TS-008", `${path}/expected`, `expected type ${expectedTypes.join("|") || "unknown"} is incompatible with source type ${types.join("|") || "unknown"}`);
  if (predicate.expected && !unexpectedExpected && ["CONTAINS", "NOT_CONTAINS"].includes(predicate.operator)) {
    const elementTypes = types.includes("array") ? schemaTypes(schema?.items) : types;
    if (!compatible(expectedTypes, elementTypes)) add(issues, "TS-008", `${path}/expected`, `contained value type ${expectedTypes.join("|") || "unknown"} is incompatible with source content type ${elementTypes.join("|") || "unknown"}`);
  }
}

export function validateTestSpecSemantics(spec: TestSpec, registry: CapabilityRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateUnique(spec, issues);
  const contracts = contractIndex(registry);
  validateRefs(spec, issues, sanctionedSecretKeyPaths(spec, contracts));
  validateReferenceOrder(spec, issues);
  const fixtures = new Map(spec.fixtures.map((value) => [value.fixtureId, value]));
  const allSteps = [...spec.setup, ...spec.steps, ...spec.cleanup];
  const steps = new Map(allSteps.map((value) => [value.stepId, value]));
  // A duplicated step ID (already reported as TS-001) makes output-path lookups
  // ambiguous; suppress the downstream TS-007 cascade for such references.
  const ambiguousStepIds = new Set(
    Object.entries(allSteps.reduce<Record<string, number>>((counts, call) => {
      counts[call.stepId] = (counts[call.stepId] ?? 0) + 1;
      return counts;
    }, {})).filter(([, count]) => count > 1).map(([stepId]) => stepId),
  );
  validateExpressionOutputPaths(spec, steps, contracts, issues, ambiguousStepIds);
  spec.setup.forEach((call, index) => validateCall(call, `/setup/${index}`, "action", fixtures, steps, contracts, issues));
  spec.steps.forEach((call, index) => validateCall(call, `/steps/${index}`, "action", fixtures, steps, contracts, issues));
  spec.cleanup.forEach((call, index) => validateCall(call, `/cleanup/${index}`, "action", fixtures, steps, contracts, issues));
  spec.preconditions.forEach((entry, index) => {
    if (entry.type !== "CAPABILITY_ASSERTION") return;
    const contract = validateCall(entry.probe, `/preconditions/${index}/probe`, "probe", fixtures, steps, contracts, issues);
    validatePredicate(
      entry.predicate,
      contract?.outputSchema,
      `/preconditions/${index}/predicate`,
      issues,
      entry.predicate.expected ? expressionTypes(entry.predicate.expected, fixtures, steps, contracts) : [],
    );
  });
  spec.assertions.forEach((entry, index) => {
    if (entry.source.type === "CAPABILITY_RESULT") validateCall(entry.source.probe, `/assertions/${index}/source/probe`, "probe", fixtures, steps, contracts, issues);
    const schema = sourceSchema(entry.source, `/assertions/${index}/source`, steps, contracts, issues, ambiguousStepIds);
    validatePredicate(
      entry.predicate,
      schema,
      `/assertions/${index}/predicate`,
      issues,
      entry.predicate.expected ? expressionTypes(entry.predicate.expected, fixtures, steps, contracts) : [],
    );
  });
  // TS-010 is enforced by running every cleanup invocation through the same
  // contract, kind, input and reference validation as ordinary actions.
  return issues;
}
