// recognition-tuning.js unit tests: the three provider-adaptation layers
// that keep the recognition preflight fast across model catalogues.
import { test } from "node:test";
import assert from "node:assert/strict";

import { planRecognitionTuning } from "../src/core/recognition-tuning.js";

test("non-reasoning models need no thinking control", () => {
  assert.deepEqual(planRecognitionTuning({ reasoning: false }), {
    note: "non-reasoning-model",
  });
});

test("layer 1: thinkingFormat models are adapter-mediated (no switch sent)", () => {
  for (const thinkingFormat of [
    "zai",
    "qwen",
    "deepseek",
    "openrouter",
    "string-thinking",
  ]) {
    assert.deepEqual(
      planRecognitionTuning({
        reasoning: true,
        compat: { thinkingFormat },
      }),
      { note: `adapter-mediated:${thinkingFormat}` },
    );
  }
});

test("layer 2: openai-style reasoning_effort models get a bounded low effort", () => {
  const plan = planRecognitionTuning({
    reasoning: true,
    api: "openai-completions",
    compat: { supportsReasoningEffort: true },
  });
  assert.deepEqual(plan, {
    reasoningEffort: "low",
    note: "reasoning-effort:low",
  });
});

test("layer 2 skipped for anthropic transport (unknown option risk)", () => {
  const plan = planRecognitionTuning({
    reasoning: true,
    api: "anthropic-messages",
    compat: { supportsReasoningEffort: true },
  });
  assert.equal(plan.note, "uncontrolled-reasoning");
});

test("layer 3: volcengine provider id gets the verified thinking-off patch", () => {
  const plan = planRecognitionTuning({
    provider: "volcengine-coding",
    id: "ark-code-latest",
    api: "openai-completions",
    reasoning: true,
    compat: { supportsReasoningEffort: false },
  });
  assert.deepEqual(plan.samplingPatch, { thinking: { type: "disabled" } });
  assert.match(plan.note, /^volcengine-ark/);
});

test("layer 3: baseUrl fragment match covers aliased provider entries", () => {
  const plan = planRecognitionTuning({
    provider: "my-ark-proxy",
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    reasoning: true,
    compat: {},
  });
  assert.deepEqual(plan.samplingPatch, { thinking: { type: "disabled" } });
});

test("unknown uncontrolled providers stay untouched (no unsafe fields)", () => {
  const plan = planRecognitionTuning({
    provider: "mystery-vendor",
    reasoning: true,
    compat: { supportsReasoningEffort: false },
  });
  assert.deepEqual(plan, { note: "uncontrolled-reasoning" });
});

test("auto:false kills the whole layer", () => {
  assert.equal(
    planRecognitionTuning(
      { provider: "volcengine-coding", reasoning: true, compat: {} },
      { auto: false },
    ),
    null,
  );
});

test("missing or malformed model objects degrade to null", () => {
  assert.equal(planRecognitionTuning(null), null);
  assert.equal(planRecognitionTuning(undefined), null);
  assert.equal(planRecognitionTuning("model"), null);
});

// Wiring: the REAL agent-classifier must hand the planned tuning to
// registry.complete — samplingParams merged (auto patch first, user
// requestBody last) and reasoningEffort through the standard channel.
import { createAgentClassifier } from "../extensions/policy-engine/agent-classifier.js";

test("createAgentClassifier forwards tuning into registry.complete options", async () => {
  const seen = [];
  const ctx = {
    model: {
      provider: "volcengine-coding",
      id: "ark-code-latest",
      api: "openai-completions",
      reasoning: true,
      compat: { supportsReasoningEffort: false },
    },
    modelRegistry: {
      complete: async (_model, _context, options) => {
        seen.push(options);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"relation":"continue"}' }],
        };
      },
    },
  };
  const classifier = createAgentClassifier(ctx);
  assert.ok(classifier);
  await classifier.complete({
    systemPrompt: "s",
    payload: "p",
    signal: undefined,
    samplingParams: { max_tokens: 99 },
  });
  const options = seen[0];
  // Auto patch + user samplingParams merge; user wins on conflicts.
  assert.deepEqual(options.samplingParams, {
    thinking: { type: "disabled" },
    max_tokens: 99,
  });
  // Uncontrolled-reasoning providers get NO reasoningEffort (the
  // adapter would ignore or mis-translate it).
  assert.equal(options.reasoningEffort, undefined);
});

test("createAgentClassifier passes reasoningEffort for layer-2 models", async () => {
  const seen = [];
  const ctx = {
    model: {
      provider: "generic-openai",
      id: "fast-model",
      api: "openai-completions",
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    },
    modelRegistry: {
      complete: async (_m, _c, options) => {
        seen.push(options);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"relation":"continue"}' }],
        };
      },
    },
  };
  const classifier = createAgentClassifier(ctx, { autoTuning: true });
  await classifier.complete({ systemPrompt: "s", payload: "p" });
  assert.equal(seen[0].reasoningEffort, "low");
  assert.equal(seen[0].samplingParams, undefined);
});

test("autoTuning:false disables the layer at classifier construction", async () => {
  const seen = [];
  const ctx = {
    model: {
      provider: "volcengine-coding",
      id: "ark-code-latest",
      reasoning: true,
      compat: {},
    },
    modelRegistry: {
      complete: async (_m, _c, options) => {
        seen.push(options);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: '{"relation":"continue"}' }],
        };
      },
    },
  };
  const classifier = createAgentClassifier(ctx, { autoTuning: false });
  await classifier.complete({ systemPrompt: "s", payload: "p" });
  assert.equal(seen[0].samplingParams, undefined);
  assert.equal(seen[0].reasoningEffort, undefined);
});

// 0.37.0: model override + token usage through the real classifier.
import { createAgentClassifier as createClassifier } from "../extensions/policy-engine/agent-classifier.js";

function registryFixture(models, calls) {
  return {
    getAvailable: () => models,
    find: (provider, id) =>
      models.find((m) => m.provider === provider && m.id === id) ?? null,
    complete: async (model, _context, options) => {
      calls.push({ model: `${model.provider}/${model.id}`, options });
      return {
        stopReason: "stop",
        content: [{ type: "text", text: '{"relation":"continue"}' }],
        usage: { input: 1531, output: 96, cacheRead: 0, cacheWrite: 0 },
      };
    },
  };
}

test("agentModel override resolves a configured model and reports usage", async () => {
  const calls = [];
  const ctx = {
    model: { provider: "zai-coding-cn", id: "glm-5.3", api: "openai-completions", reasoning: true, compat: { thinkingFormat: "zai" } },
    modelRegistry: registryFixture(
      [
        { provider: "zai-coding-cn", id: "glm-5.3", api: "openai-completions", reasoning: true, compat: { thinkingFormat: "zai" } },
        { provider: "zai-coding-cn", id: "glm-5.3-flash", api: "openai-completions", reasoning: false },
      ],
      calls,
    ),
  };
  const classifier = createClassifier(ctx, {
    modelOverride: "zai-coding-cn/glm-5.3-flash",
  });
  assert.ok(classifier);
  assert.equal(classifier.model, "zai-coding-cn/glm-5.3-flash");
  assert.equal(classifier.usingOverride, true);
  // tuning planned from the OVERRIDE model (flash: non-reasoning)
  assert.equal(classifier.tuningNote, "non-reasoning-model");
  const out = await classifier.complete({ systemPrompt: "s", payload: "p" });
  assert.equal(out.text, '{"relation":"continue"}');
  assert.deepEqual(out.usageTokens, { input: 1531, output: 96 });
  assert.equal(calls[0].model, "zai-coding-cn/glm-5.3-flash");
});

test("unresolvable override falls back to the active model", async () => {
  const calls = [];
  const ctx = {
    model: { provider: "primary", id: "big", reasoning: false },
    modelRegistry: registryFixture(
      [{ provider: "primary", id: "big", reasoning: false }],
      calls,
    ),
  };
  const classifier = createClassifier(ctx, {
    modelOverride: "ghost/model-x",
  });
  assert.equal(classifier.model, "primary/big");
  assert.equal(classifier.usingOverride, false);
  await classifier.complete({ systemPrompt: "s", payload: "p" });
  assert.equal(calls[0].model, "primary/big");
});

test("no override and null override both follow the active model", () => {
  const models = [{ provider: "p", id: "m", reasoning: false }];
  for (const modelOverride of [undefined, null]) {
    const classifier = createClassifier(
      { model: models[0], modelRegistry: registryFixture(models, []) },
      { modelOverride },
    );
    assert.equal(classifier.usingOverride, false);
  }
});
