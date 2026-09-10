/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import modeExtension from "../index.ts";

test("mode selector cancellation is silent and its title is terminal-safe", async () => {
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const titles: string[] = [];
  const optionSets: string[][] = [];

  modeExtension({
    on() {},
    registerCommand(_name: string, definition: { handler: typeof command }) {
      command = definition.handler;
    },
  } as never);

  const ctx = {
    ui: {
      setStatus() {},
      notify(message: string) {
        notices.push(message);
      },
      select: async (title: string, options: string[]) => {
        titles.push(title);
        optionSets.push(options);
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
  assert.deepEqual(
    optionSets[0]?.map((option) => option.split(" — ")[0]),
    ["请求批准", "帮我批准", "完全访问权限"],
  );
  assert.doesNotMatch(optionSets.flat().join(" "), /\b(?:ask|smart|full)\b/);
});

test("selector hides internal keys and status uses the extension-owned key", async () => {
  const setStatusCalls: Array<{ key: string; text: string | undefined }> = [];
  let statusEvent:
    | ((event: unknown, ctx: unknown) => Promise<void>)
    | undefined;
  modeExtension({
    on(
      event: string,
      handler: (event: unknown, ctx: unknown) => Promise<void>,
    ) {
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
  const modeCall = setStatusCalls.find((c) => c.key === "pi-mode-switcher");
  assert.ok(
    modeCall,
    `expected extension-owned status key — got keys: ${setStatusCalls.map((c) => c.key).join(", ")}`,
  );
  assert.ok(modeCall.text && modeCall.text.length > 0, "状态应有有效文本");
  assert.match(modeCall.text ?? "", /^(?:请求批准|帮我批准|完全访问权限)$/);
});
