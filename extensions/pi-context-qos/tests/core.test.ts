import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compressTests } from "../src/compressors/tests.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ArchiveService } from "../src/runtime/archive.ts";
import { planContext } from "../src/runtime/context.ts";
import { ContextQosController } from "../src/runtime/controller.ts";
import { planRepresentations } from "../src/runtime/planner.ts";
import { calculatePressure } from "../src/runtime/pressure.ts";
import { BlobStore } from "../src/storage/blob-store.ts";
import { ContextDatabase } from "../src/storage/database.ts";
import { collectGarbage } from "../src/storage/gc.ts";
import type { ContextQosConfig, LooseMessage } from "../src/types.ts";

function config(directory: string): ContextQosConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    storage: {
      ...DEFAULT_CONFIG.storage,
      directory,
      maxAgeDays: 30,
      maxBytes: 10_000_000,
    },
    frontier: { protectedUserTurns: 1, protectedCausalBlocks: 2 },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-qos-test-"));
  const cfg = config(directory);
  const db = new ContextDatabase(directory);
  const blobs = new BlobStore(directory);
  db.upsertSession({
    id: "session-1",
    sessionPath: "/tmp/session.jsonl",
    projectRoot: "/project",
    model: "test/model",
    contextWindow: 10_000,
  });
  return {
    directory,
    cfg,
    db,
    blobs,
    archive: new ArchiveService(cfg, db, blobs),
  };
}

test("blob store is content addressed, zstd compressed, deduplicated, and private", async () => {
  const { directory, blobs, db } = await fixture();
  try {
    const content = "repeatable evidence\n".repeat(500);
    const first = blobs.put(content);
    const second = blobs.put(content);
    assert.equal(first.hash, second.hash);
    assert.equal(second.deduplicated, true);
    assert.equal(blobs.get(first.hash), content);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(blobs.pathFor(first.hash)).mode & 0o777, 0o600);
    assert.ok(first.bytes < Buffer.byteLength(content));
  } finally {
    db.close();
  }
});

test("archive redacts secrets and refuses excluded paths", async () => {
  const { archive, blobs, db } = await fixture();
  try {
    const secret = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "entry-1",
      toolCallId: "call-secret",
      toolName: "bash",
      input: { command: "printenv" },
      rawText: "api_key=abcdefghijklmno\npostgres://alice:hunter2@db/internal",
      isError: false,
      turn: 1,
    });
    assert.ok(secret.blobHash);
    const stored = blobs.get(secret.blobHash!);
    assert.doesNotMatch(stored, /abcdefghijklmno|hunter2/);
    assert.match(stored, /REDACTED/);

    const excluded = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "entry-2",
      toolCallId: "call-env",
      toolName: "read",
      input: { path: "/project/.env" },
      rawText: "SECRET=must-not-land",
      isError: false,
      turn: 2,
    });
    assert.equal(excluded.archived, false);
    assert.equal(excluded.blobHash, null);
    assert.doesNotMatch(excluded.searchText, /must-not-land/);
  } finally {
    db.close();
  }
});

test("test compressor preserves failures and distinguishes passing verification", () => {
  const failed = compressTests(
    "182 passed, 2 failed\nFAIL tests/cache.test.ts::version\nAssertionError: 1 != 2",
  );
  assert.equal(failed.unresolved, true);
  assert.match(failed.extract, /cache\.test\.ts/);
  assert.ok(failed.importance > 0.9);

  const passed = compressTests("184 passed in 4.2s");
  assert.equal(passed.unresolved, false);
  assert.match(passed.summary.headline, /successfully/);
});

test("pressure uses output and safety reserves instead of the raw context window", () => {
  const cfg = config("/tmp/unused");
  const reading = calculatePressure(82_000, 100_000, cfg);
  assert.equal(reading.effectiveBudget, 82_000);
  assert.equal(reading.level, "critical");
  assert.equal(reading.ratio, 1);
});

test("native compaction fallback fires at the critical threshold, not only at 100%", async () => {
  // Regression: overBudget used to compare afterTokens against the raw
  // effectiveBudget (ratio > 1.0). With provider framing occupying most of
  // the window, QoS degradation cannot reclaim enough, so the fallback was
  // dead code and a session could sit at critical pressure forever.
  const { cfg, archive, db } = await fixture();
  try {
    cfg.budget.critical = 0.8;
    archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "entry-critical",
      toolCallId: "call-critical",
      toolName: "grep",
      input: { pattern: "cache" },
      rawText: `src/cache.ts: ${"old evidence ".repeat(200)}`,
      isError: false,
      turn: 1,
    });
    const result = planContext({
      messages: [
        { role: "user", content: "fix cache" },
        {
          role: "toolResult",
          toolCallId: "call-critical",
          toolName: "grep",
          content: [
            {
              type: "text",
              text: `src/cache.ts: ${"old evidence ".repeat(200)}`,
            },
          ],
        },
      ],
      usageTokens: 7_000,
      model: { contextWindow: 10_000 },
      config: cfg,
      db,
      sessionId: "session-1",
      objective: "fix cache",
      currentTurn: 2,
      visibleEntryIds: new Set(["entry-critical"]),
      frozen: false,
    });
    assert.equal(result.level, "critical");
    // 7000 / 8200 = 0.854: above the 0.8 critical line, far below 100%.
    // The old implementation returned false here and compaction never fired.
    assert.equal(
      result.overBudget,
      true,
      "post-plan pressure above the critical threshold must trigger the native fallback",
    );
  } finally {
    db.close();
  }
});

test("context planning is non-mutating, branch-aware, and protects the active frontier", async () => {
  const { cfg, archive, db } = await fixture();
  try {
    const messages: LooseMessage[] = [
      { role: "user", content: "explore cache" },
    ];
    const visible = new Set<string>();
    for (let index = 0; index < 6; index++) {
      if (index === 4) messages.push({ role: "user", content: "fix cache" });
      const origin = `entry-${index}`;
      const call = `call-${index}`;
      visible.add(origin);
      archive.archive({
        sessionId: "session-1",
        taskId: null,
        originEntryId: origin,
        toolCallId: call,
        toolName: "grep",
        input: { pattern: "cache" },
        rawText: `src/cache.ts:${index}: ${"large evidence ".repeat(200)}`,
        isError: false,
        turn: index + 1,
      });
      messages.push({
        role: "toolResult",
        toolCallId: call,
        toolName: "grep",
        content: [
          {
            type: "text",
            text: `src/cache.ts:${index}: ${"large evidence ".repeat(200)}`,
          },
        ],
      });
    }
    archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "other-branch",
      toolCallId: "hidden-call",
      toolName: "grep",
      input: {},
      rawText: "hidden branch evidence ".repeat(100),
      isError: false,
      turn: 7,
    });
    messages.splice(1, 0, {
      role: "toolResult",
      toolCallId: "hidden-call",
      content: [{ type: "text", text: "hidden branch evidence ".repeat(100) }],
    });
    const original = structuredClone(messages);
    const result = planContext({
      messages,
      usageTokens: 20_000,
      model: { contextWindow: 8_000 },
      config: cfg,
      db,
      sessionId: "session-1",
      objective: "fix cache",
      currentTurn: 8,
      visibleEntryIds: visible,
      frozen: false,
    });
    assert.deepEqual(
      messages,
      original,
      "the Pi session/context input must not be mutated",
    );
    assert.equal(result.level, "critical");
    assert.ok(result.transformed >= 4);
    assert.equal(
      result.overBudget,
      true,
      "non-message provider overhead must survive planning",
    );
    assert.deepEqual(
      result.messages.find((message) => message.toolCallId === "hidden-call"),
      original.find((message) => message.toolCallId === "hidden-call"),
      "items from another branch must remain untouched",
    );
    for (const call of ["call-4", "call-5"]) {
      assert.deepEqual(
        result.messages.find((message) => message.toolCallId === call),
        original.find((message) => message.toolCallId === call),
        "the newest causal blocks must stay raw",
      );
    }
    assert.ok(result.messages.some((message) => message.role === "user"));
  } finally {
    db.close();
  }
});

test("file snapshots supersede old versions and exact repeats deduplicate", async () => {
  const { archive, db } = await fixture();
  try {
    const first = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "a",
      toolCallId: "read-a",
      toolName: "read",
      input: { path: "/project/src/cache.ts" },
      rawText: "export const version = 1;",
      isError: false,
      turn: 1,
    });
    const second = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "b",
      toolCallId: "read-b",
      toolName: "read",
      input: { path: "/project/src/cache.ts" },
      rawText: "export const version = 2;",
      isError: false,
      turn: 2,
    });
    const third = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "c",
      toolCallId: "read-c",
      toolName: "read",
      input: { path: "/project/src/cache.ts" },
      rawText: "export const version = 2;",
      isError: false,
      turn: 3,
    });
    assert.equal(db.getItemById(first.id)?.supersededBy, second.id);
    assert.equal(third.duplicateOf, second.id);
    assert.equal(second.blobHash, third.blobHash);
  } finally {
    db.close();
  }
});

test("FTS search returns only indexed summary metadata", async () => {
  const { archive, db } = await fixture();
  try {
    const item = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "entry-search",
      toolCallId: "call-search",
      toolName: "bash",
      input: { command: "npm test" },
      rawText: "FAIL src/retry.test.ts binding mismatch",
      isError: true,
      turn: 1,
    });
    const matches = db.search("session-1", '"binding"', 5);
    assert.equal(matches[0]?.id, item.id);
  } finally {
    db.close();
  }
});

test("representations degrade monotonically and the latest file snapshot is hard-protected", async () => {
  const { archive, db } = await fixture();
  try {
    const old = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "old",
      toolCallId: "old-read",
      toolName: "read",
      input: { path: "/project/src/cache.ts" },
      rawText: "export const version = 1;",
      isError: false,
      turn: 1,
    });
    const latest = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "latest",
      toolCallId: "latest-read",
      toolName: "read",
      input: { path: "/project/src/cache.ts" },
      rawText: "export const version = 2;",
      isError: false,
      turn: 2,
    });
    const critical = planRepresentations(
      db.listItems("session-1"),
      "critical",
      "unrelated task",
      20,
      new Set(),
    );
    assert.equal(
      critical.find((decision) => decision.item.id === latest.id)
        ?.representation,
      "raw",
    );
    const oldDecision = critical.find(
      (decision) => decision.item.id === old.id,
    )!;
    db.setRepresentation(old.id, oldDecision.representation, 2, 0.1, 0.1);
    const green = planRepresentations(
      db.listItems("session-1"),
      "green",
      "cache",
      21,
      new Set(),
    );
    assert.equal(
      green.find((decision) => decision.item.id === old.id)?.representation,
      oldDecision.representation,
      "automatic planning must not expand a frozen historical prefix",
    );
  } finally {
    db.close();
  }
});

test("fork inheritance copies only visible metadata and reuses the blob", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-qos-fork-"));
  const storage = join(cwd, "store");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "context-qos.json"),
    JSON.stringify({ storage: { directory: storage } }),
  );
  const old = new ContextQosController({
    id: "old-session",
    sessionPath: join(cwd, "old.jsonl"),
    projectRoot: cwd,
    model: "test/model",
    contextWindow: 8_000,
    projectTrusted: true,
  });
  const visible = old.archiveToolResult({
    originEntryId: "visible-entry",
    toolCallId: "visible-call",
    toolName: "bash",
    toolInput: { command: "npm test" },
    rawText: "1 passed",
    isError: false,
  });
  old.archiveToolResult({
    originEntryId: "hidden-entry",
    toolCallId: "hidden-call",
    toolName: "bash",
    toolInput: { command: "npm test" },
    rawText: "1 failed",
    isError: true,
  });
  const forked = new ContextQosController({
    id: "forked-session",
    sessionPath: join(cwd, "forked.jsonl"),
    projectRoot: cwd,
    model: "test/model",
    contextWindow: 8_000,
    projectTrusted: true,
  });
  try {
    forked.setVisibleEntries([{ id: "visible-entry" }]);
    assert.equal(forked.inheritFork(join(cwd, "old.jsonl")), 1);
    const inherited = forked.db.listItems("forked-session");
    assert.equal(inherited.length, 1);
    assert.equal(inherited[0]?.toolCallId, "visible-call");
    assert.equal(inherited[0]?.blobHash, visible.blobHash);
    assert.notEqual(inherited[0]?.id, visible.id);
  } finally {
    forked.close();
    old.close();
  }
});

test("alternate branches cannot supersede file snapshots or resolve failures", async () => {
  const { archive, db } = await fixture();
  try {
    const branchAFile = archive.archive(
      {
        sessionId: "session-1",
        taskId: null,
        originEntryId: "branch-a",
        toolCallId: "read-a",
        toolName: "read",
        input: { path: "/project/src/cache.ts" },
        rawText: "export const branch = 'a';",
        isError: false,
        turn: 1,
      },
      new Set(["branch-a"]),
    );
    const branchAFailure = archive.archive(
      {
        sessionId: "session-1",
        taskId: null,
        originEntryId: "branch-a",
        toolCallId: "test-a-fail",
        toolName: "bash",
        input: { command: "pytest tests/a.py" },
        rawText: "1 failed\nFAIL tests/a.py::test_cache",
        isError: true,
        turn: 2,
      },
      new Set(["branch-a"]),
    );
    archive.archive(
      {
        sessionId: "session-1",
        taskId: null,
        originEntryId: "branch-b",
        toolCallId: "read-b",
        toolName: "read",
        input: { path: "/project/src/cache.ts" },
        rawText: "export const branch = 'b';",
        isError: false,
        turn: 3,
      },
      new Set(["branch-b"]),
    );
    archive.archive(
      {
        sessionId: "session-1",
        taskId: null,
        originEntryId: "branch-b",
        toolCallId: "test-b-pass",
        toolName: "bash",
        input: { command: "pytest tests/a.py" },
        rawText: "1 passed",
        isError: false,
        turn: 4,
      },
      new Set(["branch-b"]),
    );
    assert.equal(db.getItemById(branchAFile.id)?.supersededBy, null);
    assert.equal(db.getItemById(branchAFailure.id)?.unresolved, true);
  } finally {
    db.close();
  }
});

test("successful tests resolve only the same test command identity", async () => {
  const { archive, db } = await fixture();
  try {
    const failed = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "one",
      toolCallId: "a-fail",
      toolName: "bash",
      input: { command: "pytest tests/a.py" },
      rawText: "1 failed\nFAIL tests/a.py::test_cache",
      isError: true,
      turn: 1,
    });
    archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "two",
      toolCallId: "b-pass",
      toolName: "bash",
      input: { command: "pytest tests/b.py" },
      rawText: "1 passed",
      isError: false,
      turn: 2,
    });
    assert.equal(db.getItemById(failed.id)?.unresolved, true);
    const passed = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "three",
      toolCallId: "a-pass",
      toolName: "bash",
      input: { command: "pytest tests/a.py" },
      rawText: "1 passed",
      isError: false,
      turn: 3,
    });
    assert.equal(db.getItemById(failed.id)?.unresolved, false);
    assert.equal(db.getItemById(failed.id)?.supersededBy, passed.id);
  } finally {
    db.close();
  }
});

test("capacity GC never removes blobs referenced by pinned or unresolved items", async () => {
  const { cfg, archive, blobs, db } = await fixture();
  try {
    const item = archive.archive({
      sessionId: "session-1",
      taskId: null,
      originEntryId: "pin",
      toolCallId: "pin-call",
      toolName: "bash",
      input: { command: "printf evidence" },
      rawText: "important evidence ".repeat(500),
      isError: false,
      turn: 1,
    });
    assert.ok(item.blobHash);
    db.setPinned(item.id, true);
    cfg.storage.maxBytes = 1;
    collectGarbage(db, blobs, cfg);
    assert.equal(blobs.has(item.blobHash!), true);
    db.setPinned(item.id, false);
    collectGarbage(db, blobs, cfg);
    assert.equal(blobs.has(item.blobHash!), false);
  } finally {
    db.close();
  }
});

test("v0.2: non-raw representations are self-describing (context_recall path)", async () => {
  const { cfg, archive, db } = await fixture();
  try {
    const messages: LooseMessage[] = [{ role: "user", content: "go" }];
    const visible = new Set<string>();
    for (let index = 0; index < 6; index++) {
      // A mid-flight user turn splits the frontier: blocks 0–2 fall
      // outside the protected window and become downgradable.
      if (index === 3) messages.push({ role: "user", content: "continue" });
      const origin = `s2-entry-${index}`;
      const call = `s2-call-${index}`;
      visible.add(origin);
      archive.archive({
        sessionId: "session-1",
        taskId: null,
        originEntryId: origin,
        toolCallId: call,
        toolName: "bash",
        input: { command: "ls" },
        rawText: `evidence ${index} `.repeat(300),
        isError: false,
        turn: index + 1,
      });
      messages.push({
        role: "toolResult",
        toolCallId: call,
        toolName: "bash",
        content: [{ type: "text", text: `evidence ${index} `.repeat(300) }],
      });
    }
    const result = planContext({
      messages,
      usageTokens: 20_000,
      model: { contextWindow: 8_000 },
      config: cfg,
      db,
      sessionId: "session-1",
      objective: "work",
      currentTurn: 7,
      visibleEntryIds: visible,
      frozen: false,
    });
    assert.ok(result.transformed > 0);
    const firstTextOf = (message: LooseMessage): string => {
      const content = message.content as
        | Array<{ type?: string; text?: string }>
        | undefined;
      const first = Array.isArray(content) ? content[0] : undefined;
      return typeof first?.text === "string" ? first.text : "";
    };
    const originalTextOf = new Map(
      messages.map(
        (message) => [message.toolCallId ?? "", firstTextOf(message)] as const,
      ),
    );
    const replaced = result.messages.filter(
      (message) =>
        message.role === "toolResult" &&
        firstTextOf(message) !== "" &&
        firstTextOf(message) !== originalTextOf.get(message.toolCallId ?? ""),
    );
    assert.ok(replaced.length > 0, "some tool results must be downgraded");
    for (const message of replaced) {
      assert.match(
        firstTextOf(message),
        /context_recall\(ctx:\/\/item\/[0-9a-f-]+\)/,
        "every downgraded stub must name its recovery command",
      );
    }
    // Tombstone form specifically carries the imperative hint.
    assert.ok(
      replaced.some((message) =>
        firstTextOf(message).includes("archived · restore: context_recall("),
      ),
    );
  } finally {
    db.close();
  }
});
