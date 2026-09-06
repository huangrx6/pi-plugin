import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalizeTestSpec, testSpecHash } from "../canonical.ts";
import { validateFixtureIntegrity } from "../fixture-validator.ts";
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

test("TS-015 treats contract-declared capability inputs as sanctioned vocabulary", async () => {
  const [base, registryInput] = await fixtures;
  const sanctioned = structuredClone(registryInput);
  const upload = sanctioned.contracts.find((entry) => entry.capabilityId === "cap_document_upload")!;
  upload.inputSchema.properties!.tokenCount = { type: "integer" };

  const businessField = structuredClone(base);
  businessField.steps[0]!.input.tokenCount = { literal: 500 };
  const result = validateTestSpec(businessField, sanctioned);
  assert.equal(result.ok, true, JSON.stringify(result.semanticIssues, null, 2));

  const undeclared = validateTestSpec(businessField, registryInput);
  assert.ok(undeclared.semanticIssues.some((entry) => entry.code === "TS-015" && entry.path.endsWith("/input/tokenCount")));

  upload.inputSchema.properties!.tokenCount = { type: "string" };
  const rawMaterial = structuredClone(base);
  rawMaterial.steps[0]!.input.tokenCount = { literal: "Bearer abc.def.ghi" };
  assert.ok(validateTestSpec(rawMaterial, sanctioned).semanticIssues.some((entry) => entry.code === "TS-015" && /raw authorization material/.test(entry.message)));

  const literalPayload = structuredClone(base);
  literalPayload.steps[0]!.input.file = { literal: { cookieConsent: "accepted" } };
  assert.ok(validateTestSpec(literalPayload, sanctioned).semanticIssues.some((entry) => entry.code === "TS-015" && entry.path.includes("/input/file/literal/cookieConsent")));
});

test("TS-009 does not double-report TS-008 for the same unexpected expected", async () => {
  const [base, registry] = await fixtures;
  const spec = structuredClone(base);
  spec.assertions[0]!.predicate = { operator: "EXISTS", expected: { literal: true } };
  const flagged = validateTestSpec(spec, registry).semanticIssues.filter((entry) => ["TS-008", "TS-009"].includes(entry.code));
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.code, "TS-009");
});

test("duplicate step ID reports TS-001 without a TS-007 cascade", async () => {
  const [base, registry] = await fixtures;
  const spec = structuredClone(base);
  spec.steps[1]!.stepId = "step_upload";
  const issues = validateTestSpec(spec, registry).semanticIssues;
  assert.ok(issues.some((entry) => entry.code === "TS-001"));
  assert.ok(!issues.some((entry) => entry.code === "TS-007"));
});

test("semantic and fixture issues are reported in a single pass", async () => {
  const [base, registry] = await fixtures;
  const changed = structuredClone(base);
  changed.steps[0]!.actorRef = "actor_ghost";
  changed.fixtures[0]!.digest.value = "0".repeat(64);
  const result = await validateTestSpecWithFixtures(changed, registry, resolve(root, "examples"));
  assert.equal(result.ok, false);
  assert.ok(result.semanticIssues.some((entry) => entry.code === "TS-002"));
  assert.ok(result.semanticIssues.some((entry) => entry.code === "FIXTURE-002"));
});

test("fixture symlinks that escape the spec directory are rejected", async () => {
  const outside = mkdtempSync(join(tmpdir(), "pi-browser-test-outside-"));
  const inside = mkdtempSync(join(tmpdir(), "pi-browser-test-inside-"));
  try {
    const secret = join(outside, "secret.pdf");
    writeFileSync(secret, "secret bytes");
    const digest = createHash("sha256").update("secret bytes").digest("hex");
    const leak = join(inside, "leak.pdf");
    symlinkSync(secret, leak);
    const spec = {
      fixtures: [{ fixtureId: "fixture_leak", kind: "FILE", path: "leak.pdf", digest: { algorithm: "SHA256", value: digest } }],
    } as unknown as TestSpec;
    const issues = await validateFixtureIntegrity(spec, inside);
    assert.ok(issues.some((entry) => entry.code === "FIXTURE-001" && entry.message.includes("resolves to")));
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(inside, { recursive: true, force: true });
  }
});

test("fixture digests are computed by streaming large files", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-browser-test-stream-"));
  try {
    const big = join(scratch, "big.bin");
    const handle = await open(big, "w");
    const chunk = Buffer.alloc(1 << 20, 7);
    for (let i = 0; i < 16; i += 1) await handle.write(chunk);
    await handle.close();
    const digest = createHash("sha256").update(await readFile(big)).digest("hex");
    const spec = {
      fixtures: [{ fixtureId: "fixture_big", kind: "BINARY", path: "big.bin", digest: { algorithm: "SHA256", value: digest } }],
    } as unknown as TestSpec;
    assert.deepEqual(await validateFixtureIntegrity(spec, scratch), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("open output contracts resolve output paths through additionalProperties", async () => {
  const [spec, registryInput] = await fixtures;
  const open = structuredClone(registryInput);
  const status = open.contracts.find((entry) => entry.capabilityId === "cap_document_status")!;
  status.outputSchema = { type: "object", additionalProperties: { type: "string" } };
  const openSpec = structuredClone(spec);
  openSpec.assertions = [openSpec.assertions[0]!];
  openSpec.assertions[0]!.source.path = "/latestStatus";
  const openResult = validateTestSpec(openSpec, open);
  assert.equal(openResult.ok, true, JSON.stringify(openResult.semanticIssues, null, 2));

  const closed = structuredClone(registryInput);
  const closedStatus = closed.contracts.find((entry) => entry.capabilityId === "cap_document_status")!;
  closedStatus.outputSchema = { type: "object", additionalProperties: false, properties: { status: { enum: ["PARSED"] } } };
  const closedSpec = structuredClone(spec);
  closedSpec.assertions = [closedSpec.assertions[0]!];
  closedSpec.assertions[0]!.source.path = "/latestStatus";
  assert.ok(validateTestSpec(closedSpec, closed).semanticIssues.some((entry) => entry.code === "TS-007" && entry.path.endsWith("/source/path")));
});

test("empty capability registries fail closed", async () => {
  const [spec] = await fixtures;
  const result = validateTestSpec(spec, { contracts: [] });
  assert.equal(result.ok, false);
  assert.ok(result.semanticIssues.some((entry) => entry.code === "REGISTRY" && /at least one contract/.test(entry.message)));
});

test("non-object input schemas are reported once", async () => {
  const [spec, registryInput] = await fixtures;
  const broken = structuredClone(registryInput);
  broken.contracts = [broken.contracts[0]!];
  (broken.contracts[0] as unknown as Record<string, unknown>).inputSchema = "not a schema";
  const issues = validateTestSpec(spec, broken).semanticIssues.filter((entry) => entry.code === "REGISTRY" && entry.path.endsWith("/inputSchema"));
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /must be an object Capability Schema/);
});

test("x-pi-valueKind must not be combined with other schema keywords", async () => {
  const [spec, registryInput] = await fixtures;
  const mixed = structuredClone(registryInput);
  const upload = mixed.contracts.find((entry) => entry.capabilityId === "cap_document_upload")!;
  upload.inputSchema.properties!.file = { type: "string", "x-pi-valueKind": "FILE" } as never;
  const issues = validateTestSpec(spec, mixed).semanticIssues.filter((entry) => entry.code === "REGISTRY");
  assert.ok(issues.some((entry) => entry.path.endsWith("/properties/file/x-pi-valueKind") && /only keyword/.test(entry.message)));
});

test("published JSON Schema and the runtime validator agree across a mutation battery", async () => {
  const [base, schema] = await Promise.all([
    readJson("examples/document-upload.test-spec.json") as Promise<TestSpec>,
    readJson("schema/test-spec.schema.json"),
  ]);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const mutations: Array<[string, (spec: TestSpec) => void]> = [
    ["delete required title", (s) => { delete (s as Partial<TestSpec>).title; }],
    ["unknown top-level field", (s) => { (s as unknown as Record<string, unknown>).browser = "chromium"; }],
    ["wrong schemaVersion", (s) => { (s as unknown as Record<string, unknown>).schemaVersion = "9.9.9"; }],
    ["revision below minimum", (s) => { s.revision = 0; }],
    ["empty steps", (s) => { s.steps = []; }],
    ["empty assertions", (s) => { s.assertions = []; }],
    ["invalid stable ID", (s) => { s.caseId = "1 bad id!"; }],
    ["invalid duration", (s) => { s.assertions[0]!.within = "30 seconds"; }],
    ["invalid JSON Pointer", (s) => { s.assertions[1]!.source.path = "status"; }],
    ["duplicate tags", (s) => { s.tags = ["a", "a"]; }],
    ["cleanup with unknown when", (s) => { (s.cleanup[0] as unknown as Record<string, unknown>).when = "SOMETIMES"; }],
    ["value expression with two variants", (s) => { s.steps[0]!.input.file = { literal: 1, fixtureRef: "fixture_sample_pdf" } as never; }],
    ["actor with wrong principal type", (s) => { (s.actors[0]!.principalRequirement as Record<string, unknown>).type = "USER"; }],
    ["fixture with malformed digest", (s) => { s.fixtures[0]!.digest.value = "zz"; }],
    ["invocation with extra field", (s) => { (s.steps[0] as unknown as Record<string, unknown>).retry = 3; }],
  ];
  for (const [name, mutate] of mutations) {
    const spec = structuredClone(base);
    mutate(spec);
    const ajvOk = validate(spec);
    const handOk = validateTestSpecSchema(spec).issues.length === 0;
    assert.equal(ajvOk, handOk, `drift on "${name}": ajv=${ajvOk} runtime=${handOk} ${JSON.stringify(validateTestSpecSchema(spec).issues)}`);
  }
});
