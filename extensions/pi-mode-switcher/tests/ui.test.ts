/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import modeExtension from "../index.ts";

test("mode selector cancellation is silent and its title is terminal-safe", async () => {
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const titles: string[] = [];

  modeExtension({
    on() {},
    registerCommand(_name: string, definition: { handler: typeof command }) {
      command = definition.handler;
    },
  } as never);

  const ctx = {
    ui: {
      setStatus() {},
      notify(message: string) { notices.push(message); },
      select: async (title: string) => {
        titles.push(title);
        return undefined;
      },
      confirm: async () => false,
    },
  };

  await command?.("", ctx);
  await command?.("bad\u001b]9;notify\u0007", ctx);

  assert.deepEqual(notices, []);
  assert.equal(titles.length, 2);
  assert.doesNotMatch(titles[1], /\u001b\]9|notify/);
});

test("setStatus uses config:mode kind-prefix per footer-composer protocol", async () => {
  const setStatusCalls: Array<{ key: string; text: string | undefined }> = [];
  let statusEvent: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  modeExtension({
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      if (event === "session_start") statusEvent = handler;
    },
    registerCommand() {},
  } as unknown as Parameters<typeof modeExtension>[0]);
  assert.ok(statusEvent, "session_start handler 应该被注册");
  await statusEvent!(undefined, {
    ui: {
      setStatus(key: string, text: string | undefined) {
        setStatusCalls.push({ key, text });
      },
    },
  });
  // 至少有 1 次 status 写入（默认 mode 是 "smart"）
  const modeCall = setStatusCalls.find(c => c.key === "config:mode");
  assert.ok(modeCall, `expected setStatus("config:mode", ...) — got keys: ${setStatusCalls.map(c => c.key).join(", ")}`);
  assert.ok(modeCall.text && modeCall.text.length > 0, "config:mode 应有有效文本");
  // 旧裸 key "mode" 不应再使用
  assert.equal(setStatusCalls.some(c => c.key === "mode"), false, "不应再使用裸 key 'mode'");
});
