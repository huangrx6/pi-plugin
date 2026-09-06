import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import extension, { findDefaultRegistry, MissingJsonFileError, notify, parseCommand } from "../index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

test("command parser supports quoted paths and an explicit registry", () => {
  assert.deepEqual(
    parseCommand('validate "spec files/case.json" --registry registry.json'),
    { action: "validate", specPath: "spec files/case.json", registryPath: "registry.json" },
  );
  assert.deepEqual(
    parseCommand("hash case.json --registry=registries/prod.json"),
    { action: "hash", specPath: "case.json", registryPath: "registries/prod.json" },
  );
  assert.deepEqual(parseCommand("help"), { action: "help" });
  assert.deepEqual(parseCommand("--help"), { action: "help" });
  assert.equal(parseCommand(""), undefined);
  assert.throws(() => parseCommand("run test.json"), /validate 或 hash/);
  assert.throws(() => parseCommand("validate test.json --registry="), /缺少文件路径/);
});

const extensionRoot = resolve(import.meta.dirname, "..");

function makeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: extensionRoot,
    hasUI: true,
    ui: { notify() { /* no-op unless overridden. */ } },
    ...overrides,
  };
}

async function captureConsoleLog(run: () => Promise<void> | void): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => { logs.push(String(message)); };
  try { await run(); } finally { console.log = original; }
  return logs;
}

test("extension registers one read-only command and validates the example", async () => {
  let command: any;
  extension({ registerCommand(name: string, definition: unknown) {
    assert.equal(name, "browser-test");
    command = definition;
  } } as any);
  assert.ok(command);
  const messages: Array<{ message: string; level: string }> = [];
  await command.handler(
    "validate examples/document-upload.test-spec.json --registry examples/capability-registry.json",
    makeContext({ ui: { notify(message: string, level?: string) { messages.push({ message, level: level ?? "info" }); } } }),
  );
  assert.equal(messages.at(-1)?.level, "info");
  assert.match(messages.at(-1)?.message ?? "", /Test Spec 校验通过/);
  assert.match(messages.at(-1)?.message ?? "", /TestSpecHash：sha256:/);
});

test("command output falls back to stdout when the session has no UI", async () => {
  let command: any;
  extension({ registerCommand(_name: string, definition: unknown) { command = definition; } } as any);
  const logs = await captureConsoleLog(() => command.handler(
    "hash examples/document-upload.test-spec.json --registry examples/capability-registry.json",
    makeContext({ hasUI: false, ui: { notify() { throw new Error("notify must not be used without a UI"); } } }),
  ));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^sha256:[0-9a-f]{64}$/);
});

test("notify keeps working when the host presentation throws", async () => {
  const output = await captureConsoleLog(() => notify(
    makeContext({ ui: { notify() { throw new Error("presentation layer exploded"); } } }),
    "fallback message",
  ));
  assert.deepEqual(output, ["fallback message"]);
});

test("missing and malformed files report their role and path", async () => {
  let command: any;
  extension({ registerCommand(_name: string, definition: unknown) { command = definition; } } as any);
  const messages: string[] = [];
  const ctx = makeContext({ ui: { notify(message: string) { messages.push(message); } } });

  await command.handler("validate ghost.json --registry examples/capability-registry.json", ctx);
  assert.match(messages.at(-1)!, /Test Spec 文件不存在：.*ghost\.json/);

  await command.handler("hash examples/document-upload.test-spec.json --registry nowhere/registry.json", ctx);
  assert.match(messages.at(-1)!, /Capability Registry 文件不存在：.*nowhere\/registry\.json/);

  const scratch = mkdtempSync(join(tmpdir(), "pi-browser-test-malformed-"));
  try {
    const malformed = join(scratch, "malformed.json");
    writeFileSync(malformed, "{ schemaVersion: ");
    await command.handler(`validate examples/document-upload.test-spec.json --registry '${malformed}'`, ctx);
    assert.match(messages.at(-1)!, /Capability Registry 不是合法 JSON：.*malformed\.json/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("default registry search explains itself when nothing is found", async () => {
  let command: any;
  extension({ registerCommand(_name: string, definition: unknown) { command = definition; } } as any);
  const messages: string[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "pi-browser-test-empty-"));
  try {
    await command.handler(
      `validate '${resolve(extensionRoot, "examples/document-upload.test-spec.json")}'`,
      makeContext({ cwd: scratch, ui: { notify(message: string) { messages.push(message); } } }),
    );
    assert.match(messages.at(-1)!, /Capability Registry 文件不存在：.*capability-registry\.json/);
    assert.match(messages.at(-1)!, /--registry <path> 显式指定/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("default registry discovery walks up from nested directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-browser-test-walk-"));
  const empty = mkdtempSync(join(tmpdir(), "pi-browser-test-walk-none-"));
  try {
    mkdirSync(join(root, ".pi/browser-test"), { recursive: true });
    writeFileSync(join(root, ".pi/browser-test/capability-registry.json"), "{}");
    const nested = join(root, "specs/deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(findDefaultRegistry(nested), join(root, ".pi/browser-test/capability-registry.json"));

    const orphan = join(empty, "a/b");
    assert.equal(findDefaultRegistry(orphan), join(orphan, ".pi/browser-test/capability-registry.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("MissingJsonFileError carries an optional hint", () => {
  const error = new MissingJsonFileError("Test Spec 文件不存在：/tmp/x.json", "use --registry");
  assert.ok(error instanceof MissingJsonFileError);
  assert.equal(error.hint, "use --registry");
  assert.match(error.message, /Test Spec 文件不存在/);
});

test("help prints usage without touching any file", async () => {
  let command: any;
  extension({ registerCommand(_name: string, definition: unknown) { command = definition; } } as any);
  const messages: string[] = [];
  await command.handler(
    "help",
    makeContext({ cwd: "/definitely/not/a/project", ui: { notify(message: string) { messages.push(message); } } }),
  );
  assert.match(messages.at(-1)!, /校验：\/browser-test validate/);
  assert.match(messages.at(-1)!, /此阶段只校验业务测试语义/);
});

test("directory arguments validate every sibling test spec", async () => {
  let command: any;
  extension({ registerCommand(_name: string, definition: unknown) { command = definition; } } as any);
  const scratch = mkdtempSync(join(tmpdir(), "pi-browser-test-batch-"));
  try {
    const example = JSON.parse(readFileSync(resolve(extensionRoot, "examples/document-upload.test-spec.json"), "utf8"));
    cpSync(resolve(extensionRoot, "examples/fixtures"), join(scratch, "fixtures"), { recursive: true });
    writeFileSync(join(scratch, "valid.test-spec.json"), JSON.stringify(example));
    const brokenDigest = structuredClone(example);
    brokenDigest.fixtures[0]!.digest.value = "0".repeat(64);
    writeFileSync(join(scratch, "broken-digest.test-spec.json"), JSON.stringify(brokenDigest));
    writeFileSync(join(scratch, "malformed.test-spec.json"), "{ schemaVersion: ");
    writeFileSync(join(scratch, "unrelated.txt"), "not a spec");
    mkdirSync(join(scratch, "nested"));
    writeFileSync(join(scratch, "nested/ignored.test-spec.json"), JSON.stringify(example));

    const registry = resolve(extensionRoot, "examples/capability-registry.json");
    const messages: string[] = [];
    const ctx = makeContext({ cwd: scratch, ui: { notify(message: string) { messages.push(message); } } });
    await command.handler(`validate '${scratch}' --registry '${registry}'`, ctx);
    const validateReport = messages.at(-1)!;
    assert.match(validateReport, /1 通过，2 失败（共 3）/);
    assert.match(validateReport, /✓ valid\.test-spec\.json/);
    assert.match(validateReport, /✗ broken-digest\.test-spec\.json/);
    assert.match(validateReport, /FIXTURE-002/);
    assert.match(validateReport, /✗ malformed\.test-spec\.json/);
    assert.doesNotMatch(validateReport, /ignored/);

    await command.handler(`hash '${scratch}' --registry '${registry}'`, ctx);
    const hashReport = messages.at(-1)!;
    assert.match(hashReport, /✓ valid\.test-spec\.json sha256:[0-9a-f]{64}/);
    assert.match(hashReport, /✗ broken-digest\.test-spec\.json/);

    const empty = mkdtempSync(join(tmpdir(), "pi-browser-test-batch-empty-"));
    try {
      await command.handler(`validate '${empty}' --registry '${registry}'`, ctx);
      assert.match(messages.at(-1)!, /目录中没有 \.test-spec\.json 文件/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
