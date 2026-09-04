/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import skillExtension from "../index.ts";

test("skill activity is compact, padded by Pi, and complete when expanded", () => {
  let renderer: Function | undefined;
  skillExtension({
    getCommands: () => [],
    registerMessageRenderer(_type: string, factory: Function) {
      renderer = factory;
    },
    registerCommand() {},
    on() {},
    appendEntry() {},
  } as never);

  const longPath = `/workspace/${"deep/".repeat(24)}SKILL.md`;
  const message = {
    details: {
      names: ["review"],
      skills: [{
        name: "review\u001b]9;bad\u0007",
        location: longPath,
        content: "instructions",
      }],
    },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
  };

  const collapsed = renderer?.(message, { expanded: false, outputPad: 2 }, theme)
    .render(400) as string[];
  const expanded = renderer?.(message, { expanded: true, outputPad: 2 }, theme)
    .render(400) as string[];

  assert.match(collapsed.join("\n"), /技能已加载 review/);
  assert.doesNotMatch(collapsed.join("\n"), /SKILL\.md/);
  assert.ok(collapsed.some((line) => line.startsWith("  ◆")), "uses Pi output padding");
  assert.match(expanded.join("\n"), new RegExp(longPath.replaceAll("/", "\\/")));
  assert.doesNotMatch(expanded.join("\n"), /\u001b\]9|bad/);
});
