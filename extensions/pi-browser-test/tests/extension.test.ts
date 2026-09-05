import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import extension, { parseCommand } from "../index.ts";

test("command parser supports quoted paths and an explicit registry", () => {
  assert.deepEqual(
    parseCommand('validate "spec files/case.json" --registry registry.json'),
    { action: "validate", specPath: "spec files/case.json", registryPath: "registry.json" },
  );
  assert.equal(parseCommand(""), undefined);
  assert.throws(() => parseCommand("run test.json"), /validate 或 hash/);
});

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
    {
      cwd: resolve(import.meta.dirname, ".."),
      ui: { notify(message: string, level: string) { messages.push({ message, level }); } },
    },
  );
  assert.equal(messages.at(-1)?.level, "success");
  assert.match(messages.at(-1)?.message ?? "", /Test Spec 校验通过/);
  assert.match(messages.at(-1)?.message ?? "", /TestSpecHash：sha256:/);
});
