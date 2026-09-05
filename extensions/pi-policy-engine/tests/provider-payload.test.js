import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPolicyToProviderPayload,
  POLICY_PAYLOAD_MARKER,
} from "../src/core/provider-payload.js";

test("provider payload policy injection is idempotent for messages", () => {
  const original = {
    model: "test",
    messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }],
  };
  const once = appendPolicyToProviderPayload(original, "Policy: standard");
  const twice = appendPolicyToProviderPayload(once, "Policy: standard");
  assert.equal(original.messages[0].content, "base");
  assert.equal(twice.messages[0].content, once.messages[0].content);
  assert.match(twice.messages[0].content, new RegExp(POLICY_PAYLOAD_MARKER));
});

test("provider payload policy injection supports Anthropic system blocks", () => {
  const result = appendPolicyToProviderPayload(
    { system: [{ type: "text", text: "base" }], messages: [] },
    "Policy: read-only",
  );
  assert.equal(result.system.length, 2);
  assert.match(result.system[1].text, /Policy: read-only/);
});

test("provider payload policy injection supports instruction payloads", () => {
  const result = appendPolicyToProviderPayload(
    { instructions: "base" },
    "Policy: strict",
  );
  assert.match(result.instructions, /Policy: strict/);
});
