import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalizeTestSpec, testSpecHash } from "../canonical.ts";
import { validateTestSpecSchema } from "../schema-validator.ts";
import type { CapabilityRegistry, TestSpec } from "../types.ts";
import { validateTestSpec, validateTestSpecWithFixtures } from "../validator.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path: string) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const fixtures = Promise.all([
  readJson("examples/document-upload.test-spec.json") as Promise<TestSpec>,
  readJson("examples/capability-registry.json") as Promise<CapabilityRegistry>,
]);

test("frozen example passes structure, semantics and fixture integrity", async () => {
  const [spec, registry] = await fixtures;
  const result = await validateTestSpecWithFixtures(spec, registry, resolve(root, "examples"));
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.hash, "sha256:ccb4dfbeb8cc338c7facd2173c214f3657e6c07a3d49998c25534cbb9b2eb6c3");
  assert.equal(result.schemaIssues.length, 0);
  assert.equal(result.semanticIssues.length, 0);
});

test("cleanup when is accepted while arbitrary fields remain closed", async () => {
  const [spec] = await fixtures;
  assert.equal(validateTestSpecSchema(spec).issues.length, 0);
  const invalid = structuredClone(spec) as TestSpec & { cleanup: Array<Record<string, unknown>> };
  invalid.cleanup[0]!.locator = "#delete";
  assert.ok(validateTestSpecSchema(invalid).issues.some((entry) => entry.path.endsWith("/locator")));
});

test("schema-aware canonicalization sorts sets but preserves step order", async () => {
  const [spec] = await fixtures;
  const reorderedSets = structuredClone(spec);
  reorderedSets.tags = [...(reorderedSets.tags ?? [])].reverse();
  reorderedSets.actors = [...reorderedSets.actors].reverse();
  assert.equal(canonicalizeTestSpec(spec), canonicalizeTestSpec(reorderedSets));
  assert.equal(testSpecHash(spec), testSpecHash(reorderedSets));

  const reorderedSteps = structuredClone(spec);
  reorderedSteps.steps = [...reorderedSteps.steps].reverse();
  assert.notEqual(testSpecHash(spec), testSpecHash(reorderedSteps));

  const literalArrays = structuredClone(spec);
  literalArrays.steps[1]!.input.payload = { literal: { actors: ["second", "first"] } };
  const swappedLiteral = structuredClone(literalArrays);
  swappedLiteral.steps[1]!.input.payload = { literal: { actors: ["first", "second"] } };
  assert.notEqual(testSpecHash(literalArrays), testSpecHash(swappedLiteral));
});

test("semantic validator enforces references, order, output paths and input types", async () => {
  const [base, registry] = await fixtures;

  const future = structuredClone(base);
  future.steps[0]!.input = { documentId: { stepOutputRef: { stepId: "step_parse", path: "/accepted" } } };
  assert.ok(validateTestSpec(future, registry).semanticIssues.some((entry) => entry.code === "TS-004"));

  const unknownOutput = structuredClone(base);
  unknownOutput.steps[1]!.input.documentId = { stepOutputRef: { stepId: "step_upload", path: "/missing" } };
  assert.ok(validateTestSpec(unknownOutput, registry).semanticIssues.some((entry) => entry.code === "TS-007"));

  const wrongInput = structuredClone(base);
  wrongInput.steps[0]!.input.file = { literal: 42 };
  assert.ok(validateTestSpec(wrongInput, registry).semanticIssues.some((entry) => entry.code === "TS-006"));

  const unknownActor = structuredClone(base);
  unknownActor.steps[0]!.actorRef = "actor_missing";
  assert.ok(validateTestSpec(unknownActor, registry).semanticIssues.some((entry) => entry.code === "TS-002"));
});

test("probe effects, predicate contracts and forbidden embedded fields fail closed", async () => {
  const [base, registry] = await fixtures;
  const unsafeRegistry = structuredClone(registry);
  const status = unsafeRegistry.contracts.find((entry) => entry.capabilityId === "cap_document_status")!;
  status.sideEffect = "WRITE";
  const probeResult = validateTestSpec(base, unsafeRegistry);
  assert.ok(probeResult.semanticIssues.some((entry) => entry.code === "TS-012"));

  const predicate = structuredClone(base);
  predicate.assertions[1]!.predicate = { operator: "MATCHES", expected: { literal: "20" } };
  assert.ok(validateTestSpec(predicate, registry).semanticIssues.some((entry) => entry.code === "TS-008"));

  const expected = structuredClone(base);
  expected.assertions[0]!.predicate = { operator: "EXISTS", expected: { literal: true } };
  assert.ok(validateTestSpec(expected, registry).semanticIssues.some((entry) => entry.code === "TS-009"));

  const forbidden = structuredClone(base);
  forbidden.steps[0]!.input.file = { literal: { locator: "#upload", password: "secret", risk: "LOW", script: "return true" } };
  const codes = new Set(validateTestSpec(forbidden, registry).semanticIssues.map((entry) => entry.code));
  assert.ok(codes.has("TS-013"));
  assert.ok(codes.has("TS-014"));
  assert.ok(codes.has("TS-015"));
});

test("contract const, enum and expected types are enforced", async () => {
  const [base, registry] = await fixtures;
  const constrained = structuredClone(registry);
  const parse = constrained.contracts.find((entry) => entry.capabilityId === "cap_document_parse")!;
  parse.inputSchema.properties = {
    ...parse.inputSchema.properties,
    visibility: { type: "string", enum: ["PRIVATE"] },
  };
  parse.inputSchema.required = [...(parse.inputSchema.required ?? []), "visibility"];
  const spec = structuredClone(base);
  spec.steps[1]!.input.visibility = { literal: "PUBLIC" };
  assert.ok(validateTestSpec(spec, constrained).semanticIssues.some((entry) => entry.code === "TS-006" && /enum/.test(entry.message)));

  const wrongExpected = structuredClone(base);
  wrongExpected.assertions[1]!.predicate = { operator: "EQUALS", expected: { literal: "twenty" } };
  assert.ok(validateTestSpec(wrongExpected, registry).semanticIssues.some((entry) => entry.code === "TS-008" && entry.path.endsWith("/expected")));
});

test("fixture bytes are verified against the frozen digest", async () => {
  const [base, registry] = await fixtures;
  const changed = structuredClone(base);
  changed.fixtures[0]!.digest.value = "0".repeat(64);
  const result = await validateTestSpecWithFixtures(changed, registry, resolve(root, "examples"));
  assert.equal(result.ok, false);
  assert.ok(result.semanticIssues.some((entry) => entry.code === "FIXTURE-002"));
  assert.equal(result.hash, undefined);
});

test("published JSON Schema is valid JSON and carries the frozen draft/version", async () => {
  const schema = await readJson("schema/test-spec.schema.json") as Record<string, unknown>;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal((schema.properties as Record<string, any>).schemaVersion.const, "1.0.0");
  const [spec] = await fixtures;
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(spec), true, JSON.stringify(validate.errors));

  const invalid = structuredClone(spec) as TestSpec & { cleanup: Array<Record<string, unknown>> };
  invalid.cleanup[0]!.locator = "#delete";
  assert.equal(validate(invalid), false);
});

test("unsupported capability schema keywords fail instead of being ignored", async () => {
  const [spec, base] = await fixtures;
  const registry = structuredClone(base);
  registry.contracts[0]!.inputSchema.properties!.file = {
    type: "string",
    minLength: 10,
  } as any;
  const result = validateTestSpec(spec, registry);
  assert.equal(result.ok, false);
  assert.ok(result.semanticIssues.some((entry) => entry.code === "REGISTRY" && entry.path.endsWith("/minLength")));
});

test("array output pointers require a concrete numeric index", async () => {
  const [spec, base] = await fixtures;
  const registry = structuredClone(base);
  const upload = registry.contracts.find((entry) => entry.capabilityId === "cap_document_upload")!;
  upload.outputSchema = {
    type: "object",
    properties: {
      documents: { type: "array", items: { type: "object", properties: { documentId: { type: "string" } } } },
    },
  };
  const changed = structuredClone(spec);
  changed.steps[1]!.input.documentId = { stepOutputRef: { stepId: "step_upload", path: "/documents/latest/documentId" } };
  assert.ok(validateTestSpec(changed, registry).semanticIssues.some((entry) => entry.code === "TS-007"));
});
