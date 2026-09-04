import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../index.ts";

// Load the installed SDK, rather than the deliberately minimal ambient shim.
const sdkPackage = "@earendil-works/pi-coding-agent";
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(sdkPackage);

for (const scenario of ["resume", "cancel", "new-input"]) {
  test(`real Pi manual compaction: ${scenario}`, { timeout: 15_000 }, async () => {
    const cancel = scenario === "cancel";
    const cwd = await mkdtemp(join(tmpdir(), "pi-context-qos-runtime-"));
    let session: any;
    try {
      await mkdir(join(cwd, ".pi"));
      await writeFile(join(cwd, ".pi", "context-qos.json"), JSON.stringify({
        storage: { directory: join(cwd, "cold-store") },
        budget: { yellow: 0.2, orange: 0.3, red: 0.4, critical: 0.6 },
      }));
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
        retry: { enabled: false },
      });
      settingsManager.setProjectTrusted(true);
      let compactions = 0;
      let resolveFinished!: () => void;
      const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
      const loader = new DefaultResourceLoader({
        cwd, agentDir: join(cwd, "agent"), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi: any) => {
          extension(pi);
          pi.on("before_agent_start", (event: any) => ({
            systemPrompt: `${event.systemPrompt}\nKeep the approved API compatibility constraint: never rename login fields.`,
          }));
          pi.on("session_before_compact", (event: any) => {
            compactions++;
            if (cancel) { session.abortCompaction(); return { cancel: true }; }
            return { compaction: {
              summary: "Active objective: fix login without changing the API. Continue the pending verification.",
              firstKeptEntryId: event.branchEntries.findLast((entry: any) => entry.type === "message" && entry.message.role === "user").id,
              tokensBefore: event.preparation.tokensBefore,
            } };
          });
          pi.on("session_compact_failed", () => { setImmediate(resolveFinished); });
        }],
      });
      await loader.reload();
      const runtime = await ModelRuntime.create({
        authPath: join(cwd, "auth.json"), modelsPath: null,
        modelsStorePath: join(cwd, "models"), allowModelNetwork: false, refreshOnCreate: false,
      });
      const model = {
        id: "fake", name: "Offline test", provider: "context-qos-test", api: "openai-completions",
        baseUrl: "http://127.0.0.1:1", contextWindow: 2_000, maxTokens: 200,
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      let streams = 0;
      const activeContexts: any[] = [];
      runtime.registerProvider(model.provider, {
        api: model.api, apiKey: "offline-test-key", baseUrl: model.baseUrl, models: [model],
        streamSimple: () => { throw new Error("Provider transport must never be used by this test"); },
      });
      const manager = SessionManager.inMemory(cwd);
      for (let index = 0; index < 3; index++) {
        manager.appendMessage({ role: "user", content: [{ type: "text", text: "Historical evidence. ".repeat(1000) }], timestamp: 1 });
        manager.appendMessage({
          role: "assistant", content: [{ type: "text", text: "Historical work completed." }],
          api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
          usage: { input: 5_000, output: 10, totalTokens: 5_010, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        });
      }
      ({ session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), model,
        modelRuntime: runtime, settingsManager, sessionManager: manager, resourceLoader: loader, tools: [] }));
      await session.bindExtensions({ onError: (error: any) => { throw new Error(error.error); } });
      session.agent.streamFunction = (_model: any, context: any, options: any) => {
        streams++;
        const message = { role: "assistant", content: [{ type: "text", text: "Verification complete." }],
          api: model.api, provider: model.provider, model: model.id, stopReason: options?.signal?.aborted ? "aborted" : "stop", timestamp: Date.now(),
          usage: { input: 100, output: 10, totalTokens: 110, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (!options?.signal?.aborted) {
          activeContexts.push(context);
        }
        return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
      };
      let takeover: Promise<void> | undefined;
      session.subscribe((event: any) => {
        if (event.type === "compaction_end" && scenario === "new-input" && !takeover) {
          takeover = session.prompt("Instead, explain the remaining issue.");
        }
        if (event.type === "agent_settled" && (takeover || manager.getEntries().some((entry: any) => entry.type === "custom_message" && entry.customType === "context-qos-resume"))) resolveFinished();
      });
      await session.prompt("Fix login without changing the API.");
      await finished;
      await takeover;
      await session.waitForIdle();
      const entries = manager.getEntries();
      const resumed = entries.filter((entry: any) => entry.type === "custom_message" && entry.customType === "context-qos-resume");
      const notices = entries.filter((entry: any) => entry.type === "custom" && entry.customType === "context-qos-maintenance");
      assert.equal(resumed.length, scenario === "resume" ? 1 : 0);
      if (scenario !== "new-input") {
        assert.equal(compactions, 1);
        assert.equal(notices.at(-1)?.data.status, cancel ? "failed" : "resumed");
        assert.ok(streams <= (cancel ? 1 : 2), "no repeated continuation or compaction loop");
      }
      assert.ok(resumed.every((entry: any) => entry.display === false));
      if (!cancel) {
        const expected = scenario === "new-input" ? "Instead, explain the remaining issue." : "Continue the next unfinished step";
        assert.ok(activeContexts.length > 0);
        assert.ok(activeContexts.at(-1).messages.some((m: any) => JSON.stringify(m.content).includes(expected)));
        if (scenario === "resume") {
          assert.ok(activeContexts.at(-1).messages.some((m: any) => JSON.stringify(m.content).includes("never rename login fields")), "the continuation preserves active execution constraints");
          assert.ok(resumed[0].content.includes("never rename login fields"));
          assert.ok(resumed[0].content.length < activeContexts.at(-1).systemPrompt.length, "unchanged base instructions are not duplicated");
        }
      }
      assert.ok(!entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"), "the fake stream must not fail inside host error handling");
    } finally {
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown" });
        session.dispose();
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
