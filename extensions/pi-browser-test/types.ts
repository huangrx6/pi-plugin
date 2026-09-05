export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface StableRef { capabilityId: string; contractVersionId: string }
export type ValueExpression =
  | { literal: JsonValue }
  | { fixtureRef: string }
  | { stepOutputRef: { stepId: string; path: string } };

export interface Actor {
  actorId: string;
  name?: string;
  principalRequirement: { type: "ROLE"; roleId: string };
}

export interface Fixture {
  fixtureId: string;
  kind: "FILE" | "JSON" | "TEXT" | "BINARY";
  path: string;
  mediaType?: string;
  digest: { algorithm: "SHA256"; value: string };
}

export interface CapabilityCall {
  actorRef?: string;
  capability: StableRef;
  input: Record<string, ValueExpression>;
}

export interface CapabilityInvocation extends CapabilityCall {
  stepId: string;
  name?: string;
}

export interface CleanupInvocation extends CapabilityInvocation {
  when?: "ALWAYS" | "ON_SUCCESS" | "ON_FAILURE";
}

export type PredicateOperator =
  | "EQUALS" | "NOT_EQUALS"
  | "GREATER_THAN" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN" | "LESS_THAN_OR_EQUAL"
  | "CONTAINS" | "NOT_CONTAINS" | "MATCHES"
  | "EXISTS" | "NOT_EXISTS" | "IS_TRUE" | "IS_FALSE" | "IS_EMPTY" | "NOT_EMPTY";

export interface Predicate { operator: PredicateOperator; expected?: ValueExpression }

export type Precondition =
  | { preconditionId: string; type: "ACTOR_AUTHENTICATED"; actorRef: string }
  | { preconditionId: string; type: "CAPABILITY_ASSERTION"; probe: CapabilityCall; predicate: Predicate };

export type AssertionSource =
  | { type: "STEP_OUTPUT"; stepId: string; path: string }
  | { type: "CAPABILITY_RESULT"; probe: CapabilityCall; path: string };

export interface TestAssertion {
  assertionId: string;
  name?: string;
  source: AssertionSource;
  predicate: Predicate;
  within?: string;
}

export interface TestSpec {
  schemaVersion: "1.0.0";
  testSpecId: string;
  caseId: string;
  revision: number;
  parentTestSpecId?: string;
  title: string;
  intent: string;
  description?: string;
  tags?: string[];
  actors: Actor[];
  fixtures: Fixture[];
  preconditions: Precondition[];
  setup: CapabilityInvocation[];
  steps: CapabilityInvocation[];
  assertions: TestAssertion[];
  cleanup: CleanupInvocation[];
}

export interface SchemaNode {
  type?: "null" | "boolean" | "integer" | "number" | "string" | "array" | "object" | Array<"null" | "boolean" | "integer" | "number" | "string" | "array" | "object">;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  additionalProperties?: boolean | SchemaNode;
  enum?: JsonValue[];
  const?: JsonValue;
  "x-pi-valueKind"?: "FILE" | "BINARY";
}

export interface CapabilityContract {
  capabilityId: string;
  contractVersionId: string;
  kind: "ACTION" | "QUERY";
  sideEffect: "NONE" | "WRITE" | "DESTRUCTIVE";
  externalEffect: "NONE" | "READ" | "WRITE";
  inputSchema: SchemaNode;
  outputSchema: SchemaNode;
}

export interface CapabilityRegistry {
  contracts: CapabilityContract[];
}

export interface ValidationIssue {
  code: string;
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  schemaIssues: ValidationIssue[];
  semanticIssues: ValidationIssue[];
  canonical?: string;
  hash?: string;
}
