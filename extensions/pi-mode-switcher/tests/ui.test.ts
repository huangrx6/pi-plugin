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
