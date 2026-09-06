import type { CapabilityContract, CapabilityRegistry, JsonValue, SchemaNode, ValidationIssue } from "./types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SCHEMA_KEYS = new Set(["type", "properties", "required", "items", "additionalProperties", "enum", "const", "x-pi-valueKind"]);
const JSON_TYPES = new Set(["null", "boolean", "integer", "number", "string", "array", "object"]);

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}

function validateSchemaNode(value: unknown, path: string, fail: (path: string, message: string) => void): void {
  if (!record(value)) { fail(path, "must be a schema object"); return; }
  for (const key of Object.keys(value)) if (!SCHEMA_KEYS.has(key)) fail(`${path}/${key}`, "is outside the supported Capability Schema subset");
  if (Object.hasOwn(value, "type")) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || types.some((type) => typeof type !== "string" || !JSON_TYPES.has(type))) fail(`${path}/type`, "contains an unsupported JSON type");
  }
  if (Object.hasOwn(value, "x-pi-valueKind")) {
    if (!["FILE", "BINARY"].includes(String(value["x-pi-valueKind"]))) fail(`${path}/x-pi-valueKind`, "must be FILE or BINARY");
    for (const keyword of ["type", "properties", "required", "items", "additionalProperties", "enum", "const"]) {
      if (Object.hasOwn(value, keyword)) fail(`${path}/x-pi-valueKind`, `must be the only keyword on its schema node, found alongside ${keyword}`);
    }
  }
  if (Object.hasOwn(value, "properties")) {
    if (!record(value.properties)) fail(`${path}/properties`, "must be an object");
    else for (const [name, child] of Object.entries(value.properties)) validateSchemaNode(child, `${path}/properties/${name}`, fail);
  }
  if (Object.hasOwn(value, "required") && (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string") || new Set(value.required).size !== value.required.length)) fail(`${path}/required`, "must be an array of unique strings");
  if (Object.hasOwn(value, "items")) validateSchemaNode(value.items, `${path}/items`, fail);
  if (Object.hasOwn(value, "additionalProperties") && typeof value.additionalProperties !== "boolean") validateSchemaNode(value.additionalProperties, `${path}/additionalProperties`, fail);
  if (Object.hasOwn(value, "enum") && (!Array.isArray(value.enum) || !value.enum.length || !value.enum.every(jsonValue))) fail(`${path}/enum`, "must be a non-empty array of JSON values");
  if (Object.hasOwn(value, "const") && !jsonValue(value.const)) fail(`${path}/const`, "must be a JSON value");
}

export function parseCapabilityRegistry(input: unknown): { registry?: CapabilityRegistry; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const fail = (path: string, message: string) => issues.push({ code: "REGISTRY", path, severity: "error" as const, message });
  if (!record(input) || !Array.isArray(input.contracts)) {
    fail("/contracts", "capability registry must contain a contracts array");
    return { issues };
  }
  if (!input.contracts.length) {
    fail("/contracts", "capability registry must contain at least one contract");
    return { issues };
  }
  const keys = new Set<string>();
  input.contracts.forEach((candidate, index) => {
    const path = `/contracts/${index}`;
    if (!record(candidate)) { fail(path, "contract must be an object"); return; }
    for (const key of ["capabilityId", "contractVersionId"]) if (typeof candidate[key] !== "string" || !candidate[key]) fail(`${path}/${key}`, "must be a non-empty string");
    if (!["ACTION", "QUERY"].includes(String(candidate.kind))) fail(`${path}/kind`, "must be ACTION or QUERY");
    if (!["NONE", "WRITE", "DESTRUCTIVE"].includes(String(candidate.sideEffect))) fail(`${path}/sideEffect`, "must be NONE, WRITE or DESTRUCTIVE");
    if (!["NONE", "READ", "WRITE"].includes(String(candidate.externalEffect))) fail(`${path}/externalEffect`, "must be NONE, READ or WRITE");
    if (!record(candidate.inputSchema) || candidate.inputSchema.type !== "object") fail(`${path}/inputSchema`, "must be an object Capability Schema");
    else validateSchemaNode(candidate.inputSchema, `${path}/inputSchema`, fail);
    validateSchemaNode(candidate.outputSchema, `${path}/outputSchema`, fail);
    const key = `${candidate.capabilityId}\0${candidate.contractVersionId}`;
    if (keys.has(key)) fail(path, "duplicates a capabilityId + contractVersionId pair");
    keys.add(key);
  });
  return issues.length ? { issues } : { registry: input as unknown as CapabilityRegistry, issues };
}

export function contractIndex(registry: CapabilityRegistry): Map<string, CapabilityContract> {
  return new Map(registry.contracts.map((contract) => [`${contract.capabilityId}\0${contract.contractVersionId}`, contract]));
}

export function schemaAtPointer(root: SchemaNode, pointer: string): SchemaNode | undefined {
  if (pointer === "") return root;
  let current: SchemaNode | undefined = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current) return undefined;
    if (current.type === "array") {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      current = current.items;
    }
    else {
      const byProperty = current.properties?.[token];
      // Contracts that declare an open object output (additionalProperties as
      // a schema) sanction every property name, so the path exists there too.
      current = byProperty ?? (typeof current.additionalProperties === "object" ? current.additionalProperties : undefined);
    }
  }
  return current;
}
