/**
 * mutation-serialization.test.ts — intra-process contention coverage (0.16.0).
 *
 * Two structural fixes under test:
 *   A. Reads (list/get) must not commit — the durable revision must not
 *      advance on read-only tool calls.
 *   B. Parallel mutations from one agent turn (the classic "five creates
 *      in one message" burst) must all succeed without surfacing a
 *      CAS conflict, because executeTodo serializes them per scope.
 */

import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { describe, it } from "node:test";

import factory from "./index.ts";
import { commandRegistry, resetHarness, toolDefs } from "./test-harness.ts";
import { createInMemoryDurableTodoStore } from "./durable-store.ts";
import type { ScopeKey, ScopeKeyResolver } from "./persistence-contract.ts";
import type { TodoRuntimePersistence } from "./runtime-persistence.ts";

const TEST_SCOPE = "serialization-test-scope" as ScopeKey;

const testScopeResolver: ScopeKeyResolver<unknown> = {
	resolve: async (_ctx: unknown): Promise<ScopeKey> => TEST_SCOPE,
};

let store: ReturnType<typeof createInMemoryDurableTodoStore>;

beforeEach(() => {
	resetHarness();
	store = createInMemoryDurableTodoStore();
	const persistence: TodoRuntimePersistence = {
		scopeResolver: testScopeResolver,
		durableStore: store,
		rootDir: "(test-in-memory)",
	};
	factory(commandRegistry.api, { persistence });
});

function toolExecute(): (
	params: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }> {
	const tool = toolDefs[0] as {
		execute: (
			_toolCallId: string,
			params: unknown,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ content: Array<{ type: string; text: string }> }>;
	};
	return (params) =>
		tool.execute("test-call", params, undefined, undefined, {});
}

describe("read actions do not commit (0.16.0-A)", () => {
	it("list does not advance the durable revision", async () => {
		const exec = toolExecute();
		await exec({ action: "create", subject: "seed" });
		const afterCreate = (await store.load(TEST_SCOPE)).revision;
		assert.ok(afterCreate >= 1);

		const listed = await exec({ action: "list" });
		assert.ok(!listed.content[0]!.text.includes("NOT applied"));
		const afterList = (await store.load(TEST_SCOPE)).revision;
		assert.equal(
			afterList,
			afterCreate,
			"list must not bump the revision",
		);
	});

	it("get does not advance the durable revision", async () => {
		const exec = toolExecute();
		await exec({ action: "create", subject: "seed" });
		const afterCreate = (await store.load(TEST_SCOPE)).revision;

		const got = await exec({ action: "get", id: 1 });
		assert.ok(!got.content[0]!.text.includes("NOT applied"));
		const afterGet = (await store.load(TEST_SCOPE)).revision;
		assert.equal(afterGet, afterCreate, "get must not bump the revision");
	});
});

describe("parallel mutations serialize per scope (0.16.0-B)", () => {
	it("five parallel creates all succeed with sequential revisions", async () => {
		const exec = toolExecute();
		const results = await Promise.all(
			[1, 2, 3, 4, 5].map((n) =>
				exec({ action: "create", subject: `burst-${n}` }),
			),
		);
		for (const [index, result] of results.entries()) {
			const text = result.content[0]?.text ?? "";
			assert.ok(
				!text.includes("NOT applied"),
				`create ${index + 1} must not surface a CAS conflict, got: ${text}`,
			);
		}
		const envelope = await store.load(TEST_SCOPE);
		assert.equal(envelope.state.tasks.length, 5);
		assert.equal(envelope.revision, 5);
	});

	it("mixed parallel creates and updates all succeed", async () => {
		const exec = toolExecute();
		await exec({ action: "create", subject: "seed-1" });
		await exec({ action: "create", subject: "seed-2" });

		const results = await Promise.all([
			exec({ action: "update", id: 1, status: "in_progress" }),
			exec({ action: "update", id: 2, status: "in_progress" }),
			exec({ action: "create", subject: "burst-mid" }),
			exec({ action: "list" }),
		]);
		for (const result of results) {
			const text = result.content[0]?.text ?? "";
			assert.ok(!text.includes("NOT applied"), `unexpected conflict: ${text}`);
		}
		const envelope = await store.load(TEST_SCOPE);
		assert.equal(envelope.state.tasks.length, 3);
		assert.equal(envelope.state.tasks[0]!.status, "in_progress");
		assert.equal(envelope.state.tasks[1]!.status, "in_progress");
	});
});
