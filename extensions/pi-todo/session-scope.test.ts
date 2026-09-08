/**
 * Tests for session-scope.ts (production ScopeKeyResolver, session:v1).
 *
 * 24 tests covering:
 *   A. Resolver identity (6)
 *   B. Session/location semantics (3)
 *   C. Failure modes (4)
 *   D. Cross-session integration with real P3-B store (6)
 *   E. Architecture (5)
 *
 * Internal helpers are module-private (LOCK §9); tests exercise them
 * through the public resolver.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createFileDurableTodoStore } from "./file-durable-store.ts";
import type { TaskState } from "./types.ts";
import {
  SESSION_SCOPE_VERSION,
  ScopeResolutionError,
  createSessionScopeKeyResolver,
} from "./session-scope.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function ctxWithSession(sessionId: string, cwd?: string): unknown {
  return {
    cwd: cwd ?? "/irrelevant/for/session-scope",
    sessionManager: { getSessionId: () => sessionId },
  };
}

function stateWith(id: number, subject?: string): TaskState {
  return {
    tasks: [
      {
        id,
        subject: subject ?? `task ${id}`,
        status: "pending",
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    nextId: id + 1,
  };
}

async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── A. Resolver identity (6 tests) ─────────────────────────────────────

describe("SessionScopeKeyResolver: identity", () => {
  it("★ 1 same session id → same ScopeKey", async () => {
    const r = createSessionScopeKeyResolver();
    const k1 = await r.resolve(ctxWithSession("session-A"));
    const k2 = await r.resolve(ctxWithSession("session-A"));
    assert.equal(k1, k2);
  });

  it("★ 2 repeated resolution is deterministic (idempotent)", async () => {
    const r = createSessionScopeKeyResolver();
    const ks = await Promise.all([
      r.resolve(ctxWithSession("session-A")),
      r.resolve(ctxWithSession("session-A")),
      r.resolve(ctxWithSession("session-A")),
    ]);
    for (let i = 1; i < ks.length; i++) {
      assert.equal(ks[0], ks[i]);
    }
  });

  it("★ 3 different session id → different ScopeKey", async () => {
    const r = createSessionScopeKeyResolver();
    const k1 = await r.resolve(ctxWithSession("session-A"));
    const k2 = await r.resolve(ctxWithSession("session-B"));
    assert.notEqual(k1, k2);
  });

  it("★ 4 key starts with 'session:v1:'", async () => {
    const r = createSessionScopeKeyResolver();
    const k = await r.resolve(ctxWithSession("session-A"));
    assert.match(k, /^session:v1:/);
  });

  it("★ 5 key digest is exactly 64 hex chars (verified via resolver output)", async () => {
    const r = createSessionScopeKeyResolver();
    const k = await r.resolve(ctxWithSession("session-A"));
    const digest = k.replace(/^session:v1:/, "");
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it("★ 6 key does not embed raw session id (digest is pure hex)", async () => {
    const r = createSessionScopeKeyResolver();
    const sid = "session-A-with-identifiable-text";
    const k = await r.resolve(ctxWithSession(sid));
    const digest = k.replace(/^session:v1:/, "");
    assert.ok(!digest.includes(sid));
    assert.ok(!digest.includes("-"));
    assert.match(digest, /^[0-9a-f]{64}$/);
  });
});

// ── B. Session/location semantics (3 tests) ────────────────────────────

describe("SessionScopeKeyResolver: session/location semantics", () => {
  it("★ 7 same session id + different cwd → same ScopeKey (list follows the conversation)", async () => {
    await withTempDir("ws-a-", async (wsA) => {
      await withTempDir("ws-b-", async (wsB) => {
        const r = createSessionScopeKeyResolver();
        const k1 = await r.resolve(ctxWithSession("session-A", wsA));
        const k2 = await r.resolve(ctxWithSession("session-A", wsB));
        assert.equal(k1, k2, "cwd must not influence the session scope");
      });
    });
  });

  it("★ 8 architecture: resolver reads sessionManager.getSessionId and never ctx.cwd (comment-aware)", async () => {
    const src = await readFile("session-scope.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(
      code.includes("getSessionId"),
      "resolver must derive identity from sessionManager.getSessionId",
    );
    assert.ok(
      !code.includes(".cwd"),
      "resolver must not read ctx.cwd (session-only identity)",
    );
    assert.ok(
      !code.includes("realpath"),
      "resolver must not canonicalize paths (no location identity)",
    );
  });

  it("★ 9 cwd-only context (no sessionManager) → ScopeResolutionError (fail closed, no fallback)", async () => {
    const r = createSessionScopeKeyResolver();
    await assert.rejects(
      () => r.resolve({ cwd: "/some/workspace" }),
      ScopeResolutionError,
    );
  });
});

// ── C. Failure modes (4 tests) ──────────────────────────────────────────

describe("SessionScopeKeyResolver: failure modes", () => {
  it("★ 10 null / undefined ctx → ScopeResolutionError, no fallback", async () => {
    const r = createSessionScopeKeyResolver();
    await assert.rejects(() => r.resolve(null), ScopeResolutionError);
    await assert.rejects(() => r.resolve(undefined), ScopeResolutionError);
  });

  it("★ 11 missing sessionManager → ScopeResolutionError, no fallback", async () => {
    const r = createSessionScopeKeyResolver();
    await assert.rejects(() => r.resolve({}), ScopeResolutionError);
  });

  it("★ 12 empty session id → ScopeResolutionError, no fallback", async () => {
    const r = createSessionScopeKeyResolver();
    await assert.rejects(
      () => r.resolve(ctxWithSession("")),
      ScopeResolutionError,
    );
  });

  it("★ 13 non-string session id → ScopeResolutionError, no fallback", async () => {
    const r = createSessionScopeKeyResolver();
    await assert.rejects(
      () =>
        r.resolve({
          sessionManager: { getSessionId: () => 12345 },
        }),
      ScopeResolutionError,
    );
  });
});

// ── D. Cross-session integration (real P3-B, 6 tests) ───────────────────

describe("SessionScopeKeyResolver: cross-session integration (real P3-B)", () => {
  it("★ 14 Session A commit / Session B load (different session ids) → isolated states", async () => {
    await withTempDir("root-", async (root) => {
      const r = createSessionScopeKeyResolver();
      const scopeA = await r.resolve(ctxWithSession("session-A"));
      const scopeB = await r.resolve(ctxWithSession("session-B"));
      assert.notEqual(scopeA, scopeB);
      const storeA = createFileDurableTodoStore({ rootDir: root });
      const r1 = await storeA.commit(scopeA, 0, stateWith(7, "from A"));
      assert.equal(r1.kind, "committed");
      const storeB = createFileDurableTodoStore({ rootDir: root });
      const envB = await storeB.load(scopeB);
      assert.equal(
        envB.revision,
        0,
        "session B must not see session A's state",
      );
      assert.equal(envB.state.tasks.length, 0);
    });
  });

  it("★ 15 fresh FileDurableTodoStore instance still sees same state for the same session (restart)", async () => {
    await withTempDir("root-", async (root) => {
      const r = createSessionScopeKeyResolver();
      const scope = await r.resolve(ctxWithSession("session-X"));
      const store1 = createFileDurableTodoStore({ rootDir: root });
      await store1.commit(scope, 0, stateWith(99, "persisted"));
      const store2 = createFileDurableTodoStore({ rootDir: root });
      const env = await store2.load(scope);
      assert.equal(env.revision, 1);
      assert.equal(env.state.tasks[0]?.id, 99);
    });
  });

  it("★ 16 revision preserved across store restarts (same session)", async () => {
    await withTempDir("root-", async (root) => {
      const r = createSessionScopeKeyResolver();
      const scope = await r.resolve(ctxWithSession("session-X"));
      const store1 = createFileDurableTodoStore({ rootDir: root });
      await store1.commit(scope, 0, stateWith(1));
      await store1.commit(scope, 1, stateWith(2));
      await store1.commit(scope, 2, stateWith(3));
      const store2 = createFileDurableTodoStore({ rootDir: root });
      const env = await store2.load(scope);
      assert.equal(env.revision, 3);
    });
  });

  it("★ 17 different session states isolated (separate scopes, one store)", async () => {
    await withTempDir("root-", async (root) => {
      const r = createSessionScopeKeyResolver();
      const scopeA = await r.resolve(ctxWithSession("session-A"));
      const scopeB = await r.resolve(ctxWithSession("session-B"));
      assert.notEqual(scopeA, scopeB);
      const store = createFileDurableTodoStore({ rootDir: root });
      await store.commit(scopeA, 0, stateWith(1, "A"));
      await store.commit(scopeB, 0, stateWith(2, "B"));
      const envA = await store.load(scopeA);
      const envB = await store.load(scopeB);
      assert.equal(envA.state.tasks[0]?.subject, "A");
      assert.equal(envB.state.tasks[0]?.subject, "B");
    });
  });

  it("★ 18 same session stale-write → P3-B conflict (resolver does not retry)", async () => {
    await withTempDir("root-", async (root) => {
      const r = createSessionScopeKeyResolver();
      const scope = await r.resolve(ctxWithSession("session-A"));
      const storeA = createFileDurableTodoStore({ rootDir: root });
      const storeB = createFileDurableTodoStore({ rootDir: root });
      await storeA.commit(scope, 0, stateWith(1, "baseline"));
      const rA = await storeA.commit(scope, 1, stateWith(1, "A"));
      assert.equal(rA.kind, "committed");
      const rB = await storeB.commit(scope, 1, stateWith(2, "B"));
      assert.equal(rB.kind, "conflict");
      if (rB.kind === "conflict") {
        assert.equal(rB.expectedRevision, 1);
        assert.equal(rB.actualRevision, 2);
      }
    });
  });

  it("★ 19 same session id, different cwd → same durable state (cross-directory resume)", async () => {
    await withTempDir("ws-a-", async (wsA) => {
      await withTempDir("ws-b-", async (wsB) => {
        await withTempDir("root-", async (root) => {
          const r = createSessionScopeKeyResolver();
          const scopeA = await r.resolve(ctxWithSession("session-A", wsA));
          const scopeB = await r.resolve(ctxWithSession("session-A", wsB));
          assert.equal(scopeA, scopeB);
          const store1 = createFileDurableTodoStore({ rootDir: root });
          await store1.commit(scopeA, 0, stateWith(5, "moved with session"));
          const store2 = createFileDurableTodoStore({ rootDir: root });
          const env = await store2.load(scopeB);
          assert.equal(env.revision, 1);
          assert.equal(env.state.tasks[0]?.subject, "moved with session");
        });
      });
    });
  });
});

// ── E. Architecture (5 tests) ────────────────────────────────────────────

describe("session-scope: architecture", () => {
  it("★ 20 no TaskState cache / no second state authority (comment-aware)", async () => {
    const src = await readFile("session-scope.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/Map<.*ScopeKey/.test(code));
    assert.ok(!/Map<.*sessionId/.test(code));
    assert.ok(!/Map<.*envelope/.test(code));
  });

  it("★ 21 no P0/P1/P2/P3-A/P3-B runtime imports (comment-aware)", async () => {
    const src = await readFile("session-scope.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const forbidden = [
      "./store",
      "./reducer",
      "./mutation-",
      "./index",
      "./graph",
      "./projection",
      "./read-model",
      "./format",
      "./overlay",
      "./durable-store",
      "./file-durable-store",
      "./persistence-codec",
      "./persistence-migration",
    ];
    for (const m of forbidden) {
      assert.ok(!code.includes(`from "${m}"`), `must not import from ${m}`);
    }
  });

  it("★ 22 no CLI UX / no journal / no replay vocabulary (comment-aware)", async () => {
    const src = await readFile("session-scope.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const forbidden = [
      "Usage: /todos",
      "Conflict",
      "Task #",
      "Now ready",
      "Re-blocked",
      "Blocked by:",
      "journal",
      "replay",
      "ReplayMutationMaterial",
    ];
    for (const s of forbidden) {
      assert.ok(!code.includes(s), `forbidden vocabulary: ${s}`);
    }
  });

  it("★ 23 SESSION_SCOPE_VERSION = 1 (algorithm version pinned)", () => {
    assert.equal(SESSION_SCOPE_VERSION, 1);
  });

  it("★ 24 workspace move/rename → same ScopeKey (location-independent identity)", async () => {
    await withTempDir("ws-move-", async (ws) => {
      const r = createSessionScopeKeyResolver();
      const k1 = await r.resolve(ctxWithSession("session-A", ws));
      const moved = `${ws}-moved`;
      await rm(ws, { recursive: true, force: true });
      const k2 = await r.resolve(ctxWithSession("session-A", moved));
      assert.equal(k1, k2, "moving the directory must not change the scope");
    });
  });
});
