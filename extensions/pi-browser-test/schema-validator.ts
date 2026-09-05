import type { TestSpec, ValidationIssue } from "./types.ts";

type RecordValue = Record<string, unknown>;
const STABLE_ID = /^[A-Za-z][A-Za-z0-9._:-]{2,127}$/;
const JSON_POINTER = /^(\/([^/~]|~[01])*)*$/;
const DURATION = /^P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
const FIXTURE_KINDS = ["FILE", "JSON", "TEXT", "BINARY"];
const OPERATORS = [
  "EQUALS", "NOT_EQUALS", "GREATER_THAN", "GREATER_THAN_OR_EQUAL",
  "LESS_THAN", "LESS_THAN_OR_EQUAL", "CONTAINS", "NOT_CONTAINS",
  "MATCHES", "EXISTS", "NOT_EXISTS", "IS_TRUE", "IS_FALSE",
  "IS_EMPTY", "NOT_EMPTY",
];

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ code: "SCHEMA", path, severity: "error", message });
}

function objectShape(
  value: unknown,
  path: string,
  required: readonly string[],
  allowed: readonly string[],
  issues: ValidationIssue[],
): value is RecordValue {
  if (!record(value)) { issue(issues, path, "must be an object"); return false; }
  for (const key of required) if (!Object.hasOwn(value, key)) issue(issues, `${path}/${key}`, "is required");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issue(issues, `${path}/${key}`, "is not allowed");
  return true;
}

function stableId(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || !STABLE_ID.test(value)) issue(issues, path, "must be a stable ID (3-128 characters)");
}

function boundedString(value: unknown, path: string, issues: ValidationIssue[], min: number, max: number): void {
  if (typeof value !== "string" || value.length < min || value.length > max) issue(issues, path, `must be a string with length ${min}-${max}`);
}

function array(value: unknown, path: string, issues: ValidationIssue[], min = 0): value is unknown[] {
  if (!Array.isArray(value)) { issue(issues, path, "must be an array"); return false; }
  if (value.length < min) issue(issues, path, `must contain at least ${min} item(s)`);
  return true;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return record(value) && Object.values(value).every(isJsonValue);
}

function capabilityRef(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!objectShape(value, path, ["capabilityId", "contractVersionId"], ["capabilityId", "contractVersionId"], issues)) return;
  stableId(value.capabilityId, `${path}/capabilityId`, issues);
  stableId(value.contractVersionId, `${path}/contractVersionId`, issues);
}

function valueExpression(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!record(value)) { issue(issues, path, "must be a ValueExpression object"); return; }
  const variants = ["literal", "fixtureRef", "stepOutputRef"].filter((key) => Object.hasOwn(value, key));
  if (variants.length !== 1 || Object.keys(value).length !== 1) {
    issue(issues, path, "must contain exactly one of literal, fixtureRef or stepOutputRef");
    return;
  }
  if (variants[0] === "literal") {
    if (!isJsonValue(value.literal)) issue(issues, `${path}/literal`, "must be a finite JSON value");
    return;
  }
  if (variants[0] === "fixtureRef") {
    stableId(value.fixtureRef, `${path}/fixtureRef`, issues);
    return;
  }
  if (!objectShape(value.stepOutputRef, `${path}/stepOutputRef`, ["stepId", "path"], ["stepId", "path"], issues)) return;
  stableId(value.stepOutputRef.stepId, `${path}/stepOutputRef/stepId`, issues);
  if (typeof value.stepOutputRef.path !== "string" || !JSON_POINTER.test(value.stepOutputRef.path)) issue(issues, `${path}/stepOutputRef/path`, "must be a valid JSON Pointer");
}

function inputMap(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!record(value)) { issue(issues, path, "must be an input object"); return; }
  for (const [key, expression] of Object.entries(value)) valueExpression(expression, `${path}/${key}`, issues);
}

function capabilityCall(value: RecordValue, path: string, issues: ValidationIssue[]): void {
  if (Object.hasOwn(value, "actorRef")) stableId(value.actorRef, `${path}/actorRef`, issues);
  capabilityRef(value.capability, `${path}/capability`, issues);
  inputMap(value.input, `${path}/input`, issues);
}

function invocation(value: unknown, path: string, issues: ValidationIssue[], cleanup = false): void {
  const allowed = ["stepId", "name", "actorRef", "capability", "input", ...(cleanup ? ["when"] : [])];
  if (!objectShape(value, path, ["stepId", "capability", "input"], allowed, issues)) return;
  stableId(value.stepId, `${path}/stepId`, issues);
  if (Object.hasOwn(value, "name")) boundedString(value.name, `${path}/name`, issues, 1, 256);
  capabilityCall(value, path, issues);
  if (cleanup && Object.hasOwn(value, "when") && !["ALWAYS", "ON_SUCCESS", "ON_FAILURE"].includes(String(value.when))) issue(issues, `${path}/when`, "must be ALWAYS, ON_SUCCESS or ON_FAILURE");
}

function predicate(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!objectShape(value, path, ["operator"], ["operator", "expected"], issues)) return;
  if (!OPERATORS.includes(String(value.operator))) issue(issues, `${path}/operator`, "is not a supported v1.0 operator");
  if (Object.hasOwn(value, "expected")) valueExpression(value.expected, `${path}/expected`, issues);
}

function actor(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!objectShape(value, path, ["actorId", "principalRequirement"], ["actorId", "name", "principalRequirement"], issues)) return;
  stableId(value.actorId, `${path}/actorId`, issues);
  if (Object.hasOwn(value, "name")) boundedString(value.name, `${path}/name`, issues, 1, 128);
  if (!objectShape(value.principalRequirement, `${path}/principalRequirement`, ["type", "roleId"], ["type", "roleId"], issues)) return;
  if (value.principalRequirement.type !== "ROLE") issue(issues, `${path}/principalRequirement/type`, "must be ROLE");
  stableId(value.principalRequirement.roleId, `${path}/principalRequirement/roleId`, issues);
}

function fixture(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!objectShape(value, path, ["fixtureId", "kind", "path", "digest"], ["fixtureId", "kind", "path", "mediaType", "digest"], issues)) return;
  stableId(value.fixtureId, `${path}/fixtureId`, issues);
  if (!FIXTURE_KINDS.includes(String(value.kind))) issue(issues, `${path}/kind`, "is not a supported fixture kind");
  boundedString(value.path, `${path}/path`, issues, 1, Number.MAX_SAFE_INTEGER);
  if (Object.hasOwn(value, "mediaType") && typeof value.mediaType !== "string") issue(issues, `${path}/mediaType`, "must be a string");
  if (!objectShape(value.digest, `${path}/digest`, ["algorithm", "value"], ["algorithm", "value"], issues)) return;
  if (value.digest.algorithm !== "SHA256") issue(issues, `${path}/digest/algorithm`, "must be SHA256");
  if (typeof value.digest.value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.digest.value)) issue(issues, `${path}/digest/value`, "must be a 64-character SHA-256 digest");
}

function probe(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!objectShape(value, path, ["capability", "input"], ["actorRef", "capability", "input"], issues)) return;
  capabilityCall(value, path, issues);
}

function precondition(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!record(value)) { issue(issues, path, "must be a precondition object"); return; }
  if (value.type === "ACTOR_AUTHENTICATED") {
    if (!objectShape(value, path, ["preconditionId", "type", "actorRef"], ["preconditionId", "type", "actorRef"], issues)) return;
    stableId(value.preconditionId, `${path}/preconditionId`, issues);
    stableId(value.actorRef, `${path}/actorRef`, issues);
    return;
  }
  if (value.type === "CAPABILITY_ASSERTION") {
    if (!objectShape(value, path, ["preconditionId", "type", "probe", "predicate"], ["preconditionId", "type", "probe", "predicate"], issues)) return;
    stableId(value.preconditionId, `${path}/preconditionId`, issues);
    probe(value.probe, `${path}/probe`, issues);
    predicate(value.predicate, `${path}/predicate`, issues);
    return;
  }
  issue(issues, `${path}/type`, "must be ACTOR_AUTHENTICATED or CAPABILITY_ASSERTION");
}

function assertion(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!objectShape(value, path, ["assertionId", "source", "predicate"], ["assertionId", "name", "source", "predicate", "within"], issues)) return;
  stableId(value.assertionId, `${path}/assertionId`, issues);
  if (Object.hasOwn(value, "name")) boundedString(value.name, `${path}/name`, issues, 1, 256);
  if (!record(value.source)) issue(issues, `${path}/source`, "must be an assertion source object");
  else if (value.source.type === "STEP_OUTPUT") {
    if (objectShape(value.source, `${path}/source`, ["type", "stepId", "path"], ["type", "stepId", "path"], issues)) {
      stableId(value.source.stepId, `${path}/source/stepId`, issues);
      if (typeof value.source.path !== "string" || !JSON_POINTER.test(value.source.path)) issue(issues, `${path}/source/path`, "must be a valid JSON Pointer");
    }
  } else if (value.source.type === "CAPABILITY_RESULT") {
    if (objectShape(value.source, `${path}/source`, ["type", "probe", "path"], ["type", "probe", "path"], issues)) {
      probe(value.source.probe, `${path}/source/probe`, issues);
      if (typeof value.source.path !== "string" || !JSON_POINTER.test(value.source.path)) issue(issues, `${path}/source/path`, "must be a valid JSON Pointer");
    }
  } else issue(issues, `${path}/source/type`, "must be STEP_OUTPUT or CAPABILITY_RESULT");
  predicate(value.predicate, `${path}/predicate`, issues);
  if (Object.hasOwn(value, "within") && (typeof value.within !== "string" || !DURATION.test(value.within))) issue(issues, `${path}/within`, "must be an ISO-8601 duration such as PT30S");
}

export function validateTestSpecSchema(input: unknown): { value?: TestSpec; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const required = ["schemaVersion", "testSpecId", "caseId", "revision", "title", "intent", "actors", "fixtures", "preconditions", "setup", "steps", "assertions", "cleanup"];
  const allowed = [...required, "parentTestSpecId", "description", "tags"];
  if (!objectShape(input, "", required, allowed, issues)) return { issues };
  if (input.schemaVersion !== "1.0.0") issue(issues, "/schemaVersion", "must equal 1.0.0");
  stableId(input.testSpecId, "/testSpecId", issues);
  stableId(input.caseId, "/caseId", issues);
  if (!Number.isInteger(input.revision) || Number(input.revision) < 1) issue(issues, "/revision", "must be an integer greater than or equal to 1");
  if (Object.hasOwn(input, "parentTestSpecId")) stableId(input.parentTestSpecId, "/parentTestSpecId", issues);
  boundedString(input.title, "/title", issues, 1, 256);
  boundedString(input.intent, "/intent", issues, 1, 4096);
  if (Object.hasOwn(input, "description")) boundedString(input.description, "/description", issues, 0, 8192);
  if (Object.hasOwn(input, "tags") && array(input.tags, "/tags", issues)) {
    const seen = new Set<string>();
    input.tags.forEach((tag, index) => {
      boundedString(tag, `/tags/${index}`, issues, 1, 128);
      if (typeof tag === "string" && seen.has(tag)) issue(issues, `/tags/${index}`, "must be unique");
      if (typeof tag === "string") seen.add(tag);
    });
  }
  if (array(input.actors, "/actors", issues)) input.actors.forEach((entry, index) => actor(entry, `/actors/${index}`, issues));
  if (array(input.fixtures, "/fixtures", issues)) input.fixtures.forEach((entry, index) => fixture(entry, `/fixtures/${index}`, issues));
  if (array(input.preconditions, "/preconditions", issues)) input.preconditions.forEach((entry, index) => precondition(entry, `/preconditions/${index}`, issues));
  if (array(input.setup, "/setup", issues)) input.setup.forEach((entry, index) => invocation(entry, `/setup/${index}`, issues));
  if (array(input.steps, "/steps", issues, 1)) input.steps.forEach((entry, index) => invocation(entry, `/steps/${index}`, issues));
  if (array(input.assertions, "/assertions", issues, 1)) input.assertions.forEach((entry, index) => assertion(entry, `/assertions/${index}`, issues));
  if (array(input.cleanup, "/cleanup", issues)) input.cleanup.forEach((entry, index) => invocation(entry, `/cleanup/${index}`, issues, true));
  return issues.length ? { issues } : { value: input as unknown as TestSpec, issues };
}
