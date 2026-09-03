/**
 * Tests for workspace-scope.ts (P3-C production ScopeKeyResolver).
 *
 * 23 tests covering:
 *   A. Resolver identity (8)
 *   B. Session independence (3)
 *   C. Failure (2)
 *   D. Real cross-session integration (5)
 *   E. Architecture (5)
 *
 * Internal helpers are module-private (LOCK §22); tests exercise them
 * through the public resolver.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createFileDurableTodoStore } from "./file-durable-store.ts";
import type { TaskState } from "./types.ts";
import {
  WORKSPACE_SCOPE_VERSION,
  ScopeResolutionError,
  createWorkspaceScopeKeyResolver,
} from "./workspace-scope.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function ctxWith(cwd: string): unknown {
  return { cwd };
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

async function withWorkspace<T>(
  fn: (workspace: string) => Promise<T>,
): Promise<T> {
  const ws = await mkdtemp(join(tmpdir(), "ws-"));
  try {
    return await fn(ws);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

// ── A. Resolver identity (8 tests) ─────────────────────────────────────

describe("WorkspaceScopeKeyResolver: identity", () => {
  it("★ 1 same cwd → same ScopeKey", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k1 = await r.resolve(ctxWith(ws));
      const k2 = await r.resolve(ctxWith(ws));
      assert.equal(k1, k2);
    });
  });

  it("★ 2 repeated resolution is deterministic (idempotent)", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const ks = await Promise.all([
        r.resolve(ctxWith(ws)),
        r.resolve(ctxWith(ws)),
        r.resolve(ctxWith(ws)),
      ]);
      for (let i = 1; i < ks.length; i++) {
        assert.equal(ks[0], ks[i]);
      }
    });
  });

  it("★ 3 different cwd → different ScopeKey", async () => {
    await withWorkspace(async (ws1) => {
      await withWorkspace(async (ws2) => {
        const r = createWorkspaceScopeKeyResolver();
        const k1 = await r.resolve(ctxWith(ws1));
        const k2 = await r.resolve(ctxWith(ws2));
        assert.notEqual(k1, k2);
      });
    });
  });

  it("★ 4 trailing slash / '.' alias → same key (path.resolve normalization)", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k1 = await r.resolve(ctxWith(ws));
      const k2 = await r.resolve(ctxWith(`${ws}/.`));
      const k3 = await r.resolve(ctxWith(`${ws}/`));
      assert.equal(k1, k2);
      assert.equal(k2, k3);
    });
  });

  it("★ 5 symlink alias → same ScopeKey (realpath canonicalization)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ws-sym-"));
    const link = `${ws}-link`;
    try {
      await symlink(ws, link);
      const r = createWorkspaceScopeKeyResolver();
      const k1 = await r.resolve(ctxWith(ws));
      const k2 = await r.resolve(ctxWith(link));
      assert.equal(k1, k2);
    } finally {
      await rm(link, { force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("★ 6 key starts with 'workspace:v1:'", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k = await r.resolve(ctxWith(ws));
      assert.match(k, /^workspace:v1:/);
    });
  });

  it("★ 7 key digest is exactly 64 hex chars (verified via resolver output)", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k = await r.resolve(ctxWith(ws));
      const digest = k.replace(/^workspace:v1:/, "");
      assert.match(digest, /^[0-9a-f]{64}$/);
    });
  });

  it("★ 8 key does not embed raw cwd (digest is pure hex)", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k = await r.resolve(ctxWith(ws));
      const digest = k.replace(/^workspace:v1:/, "");
      assert.ok(!digest.includes("/"));
      assert.ok(!digest.includes("."));
      assert.match(digest, /^[0-9a-f]{64}$/);
    });
  });
});

// ── B. Session independence (3 tests) ─────────────────────────────────

describe("WorkspaceScopeKeyResolver: session independence", () => {
  it("★ 9 same cwd + different session ids → same ScopeKey", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k1 = await r.resolve({ cwd: ws, sessionId: "session-A" });
      const k2 = await r.resolve({ cwd: ws, sessionId: "session-B" });
      assert.equal(k1, k2);
    });
  });

  it("★ 10 session metadata changes → same ScopeKey", async () => {
    await withWorkspace(async (ws) => {
      const r = createWorkspaceScopeKeyResolver();
      const k1 = await r.resolve({ cwd: ws, branch: "main" });
      const k2 = await r.resolve({ cwd: ws, branch: "feature" });
      const k3 = await r.resolve({
        cwd: ws,
        sessionId: "X",
        conversationId: "Y",
      });
      assert.equal(k1, k2);
      assert.equal(k2, k3);
    });
  });

  it("★ 11 architecture: no sessionManager / getSessionId reference (comment-aware)", async () => {
    const src = await readFile("workspace-scope.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/sessionManager/.test(code));
    assert.ok(!/getSessionId/.test(code));
    assert.ok(!/sessionId\s*:/.test(code));
  });
});

// ── C. Failure (2 tests) ───────────────────────────────────────────────

describe("WorkspaceScopeKeyResolver: failure modes", () => {
  it("★ 12 missing/empty cwd → ScopeResolutionError", async () => {
    const r = createWorkspaceScopeKeyResolver();
    await assert.rejects(
      () => r.resolve({ cwd: "" }),
      (e: unknown) =>
        e instanceof ScopeResolutionError &&
        (e as ScopeResolutionError).kind === "scope-resolution",
    );
    await assert.rejects(
      () => r.resolve({}),
      (e: unknown) =>
        e instanceof ScopeResolutionError &&
        (e as ScopeResolutionError).kind === "scope-resolution",
    );
  });

  it("★ 13 realpath failure (nonexistent path) → error, no fallback", async () => {
    const r = createWorkspaceScopeKeyResolver();
    await assert.rejects(
      () =>
        r.resolve({
          cwd: "/this/path/definitely/does/not/exist/xyz12345",
        }),
      (e: unknown) =>
        e instanceof ScopeResolutionError &&
        (e as ScopeResolutionError).kind === "scope-resolution",
    );
  });
});

// ── D. Real cross-session integration (5 tests) ──────────────────────

describe("WorkspaceScopeKeyResolver: cross-session integration (real P3-B)", () => {
  it("★ 14 Session A commit / Session B load same workspace (different session metadata)", async () => {
    await withWorkspace(async (ws) => {
      const root = await mkdtemp(join(tmpdir(), "root-"));
      try {
        const r = createWorkspaceScopeKeyResolver();
        const scopeA = await r.resolve({ cwd: ws, sessionId: "session-A" });
        const scopeB = await r.resolve({ cwd: ws, sessionId: "session-B" });
        assert.equal(scopeA, scopeB);
        const storeA = createFileDurableTodoStore({ rootDir: root });
        const r1 = await storeA.commit(scopeA, 0, stateWith(7, "from A"));
        assert.equal(r1.kind, "committed");
        const storeB = createFileDurableTodoStore({ rootDir: root });
        const env = await storeB.load(scopeB);
        assert.equal(env.revision, 1);
        assert.equal(env.state.tasks[0]?.subject, "from A");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("★ 15 fresh FileDurableTodoStore instance still sees same state (restart)", async () => {
    await withWorkspace(async (ws) => {
      const root = await mkdtemp(join(tmpdir(), "root-"));
      try {
        const r = createWorkspaceScopeKeyResolver();
        const scope = await r.resolve({ cwd: ws, sessionId: "X" });
        const store1 = createFileDurableTodoStore({ rootDir: root });
        await store1.commit(scope, 0, stateWith(99, "persisted"));
        const store2 = createFileDurableTodoStore({ rootDir: root });
        const env = await store2.load(scope);
        assert.equal(env.revision, 1);
        assert.equal(env.state.tasks[0]?.id, 99);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("★ 16 revision preserved across sessions / restart", async () => {
    await withWorkspace(async (ws) => {
      const root = await mkdtemp(join(tmpdir(), "root-"));
      try {
        const r = createWorkspaceScopeKeyResolver();
        const scope = await r.resolve({ cwd: ws });
        const store1 = createFileDurableTodoStore({ rootDir: root });
        await store1.commit(scope, 0, stateWith(1));
        await store1.commit(scope, 1, stateWith(2));
        await store1.commit(scope, 2, stateWith(3));
        const store2 = createFileDurableTodoStore({ rootDir: root });
        const env = await store2.load(scope);
        assert.equal(env.revision, 3);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it("★ 17 different workspace state isolated (separate scopes)", async () => {
    await withWorkspace(async (wsA) => {
      await withWorkspace(async (wsB) => {
        const root = await mkdtemp(join(tmpdir(), "root-"));
        try {
          const r = createWorkspaceScopeKeyResolver();
          const scopeA = await r.resolve({ cwd: wsA });
          const scopeB = await r.resolve({ cwd: wsB });
          assert.notEqual(scopeA, scopeB);
          const store = createFileDurableTodoStore({ rootDir: root });
          await store.commit(scopeA, 0, stateWith(1, "wsA"));
          await store.commit(scopeB, 0, stateWith(2, "wsB"));
          const envA = await store.load(scopeA);
          const envB = await store.load(scopeB);
          assert.equal(envA.state.tasks[0]?.id, 1);
          assert.equal(envA.state.tasks[0]?.subject, "wsA");
          assert.equal(envB.state.tasks[0]?.id, 2);
          assert.equal(envB.state.tasks[0]?.subject, "wsB");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  });

  it("★ 18 two sessions same scope stale-write → P3-B conflict (P3-C does not retry)", async () => {
    await withWorkspace(async (ws) => {
      const root = await mkdtemp(join(tmpdir(), "root-"));
      try {
        const r = createWorkspaceScopeKeyResolver();
        const scopeA = await r.resolve({ cwd: ws, sessionId: "A" });
        const scopeB = await r.resolve({ cwd: ws, sessionId: "B" });
        assert.equal(scopeA, scopeB);
        const storeA = createFileDurableTodoStore({ rootDir: root });
        const storeB = createFileDurableTodoStore({ rootDir: root });
        await storeA.commit(scopeA, 0, stateWith(1, "baseline"));
        const rA = await storeA.commit(scopeA, 1, stateWith(1, "A"));
        assert.equal(rA.kind, "committed");
        const rB = await storeB.commit(scopeB, 1, stateWith(2, "B"));
        assert.equal(rB.kind, "conflict");
        if (rB.kind === "conflict") {
          assert.equal(rB.expectedRevision, 1);
          assert.equal(rB.actualRevision, 2);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});

// ── E. Architecture (5 tests) ────────────────────────────────────────────

describe("workspace-scope: architecture", () => {
  it("★ 19 no TaskState cache / no second state authority (comment-aware)", async () => {
    const src = await readFile("workspace-scope.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/Map<.*ScopeKey/.test(code));
    assert.ok(!/Map<.*sessionId/.test(code));
    assert.ok(!/Map<.*envelope/.test(code));
  });

  it("★ 20 no P0/P1/P2/P3-A/P3-B runtime imports (comment-aware)", async () => {
    const src = await readFile("workspace-scope.ts", "utf8");
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

  it("★ 21 no CLI UX / no journal / no replay vocabulary (comment-aware)", async () => {
    const src = await readFile("workspace-scope.ts", "utf8");
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

  it("★ 22 WORKSPACE_SCOPE_VERSION = 1 (algorithm version pinned)", () => {
    assert.equal(WORKSPACE_SCOPE_VERSION, 1);
  });

  it("★ 23 workspace rename/move → different ScopeKey (location-based identity, LOCK §25)", async () => {
    const original = await mkdtemp(join(tmpdir(), "ws-rename-"));
    const renamed = `${original}-renamed`;
    try {
      const r = createWorkspaceScopeKeyResolver();
      const k1 = await r.resolve({ cwd: original });
      await rename(original, renamed);
      const k2 = await r.resolve({ cwd: renamed });
      assert.notEqual(k1, k2, "rename must produce different ScopeKey");
    } finally {
      await rm(renamed, { recursive: true, force: true });
    }
  });
});
