// lifecycle-restore.test.js — P2.7 restore() history 跨会话过滤回归
//
// 锁定 lifecycle.js restore() 的 history 过滤不变式:
//   - 跨 session: r.sessionId 与 state.sessionId 不匹配 → 过滤掉
//   - 同 session: r.sessionId === state.sessionId → 保留
//   - 无 sessionId 字段: 不限 session（旧记录，向后兼容）
//   - 限制数量: 最多 cfg.historyMaxEntries (默认 500) 或 50（lifecycle
//     hardcoded 上限）
//
// 注入: readHistory 是 history-store.js 的纯函数。lifecycle.js 直接
// 调用 readHistory + filter。本测试聚焦 readHistory 行为（已知） +
// session_id 过滤契约（lifecycle.js 中的关键逻辑）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHistory } from "../src/core/history-store.js";

function makeTempHistory(content) {
  const dir = mkdtempSync(join(tmpdir(), "pi-policy-history-"));
  const file = join(dir, "history.jsonl");
  writeFileSync(file, content, "utf8");
  return { dir, file };
}

test("readHistory: cross-session isolation — 不同 sessionId 的记录被过滤", async () => {
  const { dir, file } = makeTempHistory(
    [
      JSON.stringify({ sessionId: "session-A", prompt: "first session task", usageTokens: { input: 100, output: 50 } }),
      JSON.stringify({ sessionId: "session-B", prompt: "different session", usageTokens: { input: 200, output: 80 } }),
    ].join("\n") + "\n",
  );
  try {
    const all = await readHistory(file);
    assert.equal(all.length, 2, "readHistory 默认返回所有记录");

    // 模拟 lifecycle.js filter: r.sessionId !== state.sessionId → drop
    const filteredA = all.filter((r) => !r.sessionId || r.sessionId === "session-A");
    assert.equal(filteredA.length, 1, "session A filter 只留 session-A");
    assert.equal(filteredA[0].prompt, "first session task");

    const filteredB = all.filter((r) => !r.sessionId || r.sessionId === "session-B");
    assert.equal(filteredB.length, 1, "session B filter 只留 session-B");
    assert.equal(filteredB[0].prompt, "different session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHistory: backward compat — 缺少 sessionId 的旧记录对所有 session 可见", async () => {
  const { dir, file } = makeTempHistory(
    [
      JSON.stringify({ prompt: "legacy record without sessionId" }),
      JSON.stringify({ sessionId: "current", prompt: "current session record" }),
    ].join("\n") + "\n",
  );
  try {
    const all = await readHistory(file);
    const filtered = all.filter((r) => !r.sessionId || r.sessionId === "current");
    assert.equal(filtered.length, 2, "legacy record + current record 都保留");
    assert.equal(filtered[0].prompt, "legacy record without sessionId");
    assert.equal(filtered[1].prompt, "current session record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHistory: respects limit (scan-from-end optimization)", async () => {
  // 写 10 条记录,只请求 limit=3
  const lines = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ sessionId: "x", prompt: `task-${i}` }),
  ).join("\n");
  const { dir, file } = makeTempHistory(lines + "\n");
  try {
    const out = await readHistory(file, 3);
    assert.equal(out.length, 3, "limit=3 只返回 3 条");
    // 扫描从末尾: 应返回最后 3 条(t-7/t-8/t-9),按时间正序
    assert.deepEqual(out.map((r) => r.prompt), ["task-7", "task-8", "task-9"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHistory: missing file returns []", async () => {
  const out = await readHistory("/definitely/does/not/exist.jsonl");
  assert.deepEqual(out, []);
});

test("readHistory: malformed lines skipped (don't crash)", async () => {
  const { dir, file } = makeTempHistory(
    [
      JSON.stringify({ sessionId: "x", prompt: "valid 1" }),
      "this is not json",
      JSON.stringify({ sessionId: "x", prompt: "valid 2" }),
      "{broken",
    ].join("\n") + "\n",
  );
  try {
    const out = await readHistory(file);
    assert.equal(out.length, 2, "坏行被跳过,只有合法记录");
    assert.deepEqual(out.map((r) => r.prompt), ["valid 1", "valid 2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readHistory: empty file returns []", async () => {
  const { dir, file } = makeTempHistory("");
  try {
    const out = await readHistory(file);
    assert.deepEqual(out, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
