import assert from "node:assert/strict";
import test from "node:test";
import { panelContent, panelLines, summary } from "../render.ts";
import { defaultFooterConfig } from "../config.ts";
import { emptySnapshot } from "../types.ts";
import { visibleWidth } from "../layout.ts";
const theme = { fg: (_color: string, text: string) => text };
test("summary and all cards stay within terminal widths, including CJK and long external content", () => {
  const s = emptySnapshot(); s.rounds = 1; s.steps = 77; s.context = { tokens: 166144, contextWindow: 1048576, percent: 15.85 };
  s.usage = { input: 97812, cacheRead: 7150099, output: 75945, cacheWrite: 0, cost: 1.38 };
  s.metrics = { ...s.metrics, calls: 77, llmMs: 305000, rateTokens: 75945, rateMs: 305000 };
  const config = defaultFooterConfig(); config.more.sections = [{ label: "诊断", status: "diagnostics" }];
  const statuses = new Map([["diagnostics", "\x1b]52;c;unsafe\x07中文".repeat(50) + "\nfile.ts"]]);
  for (const icons of ["unicode", "ascii"] as const) {
    config.icons = icons;
    for (let width = 1; width <= 160; width++) {
      const result = summary(s, config, width, null, theme);
      assert.ok(visibleWidth(result.line) <= width, `${width}: ${result.line}`);
      for (const hit of result.hits) assert.ok(hit.x >= 0 && hit.x + hit.width <= width);
      for (const id of ["stats", "tokens", "context", "more"] as const) {
        const card = panelLines(id, s, config, statuses, width, 13, 0, theme);
        assert.ok(card.lines.length <= 13);
        for (const line of card.lines) { assert.ok(visibleWidth(line) <= width, `${width}: ${line}`); assert.doesNotMatch(line, /unsafe|\x1b/); }
      }
    }
  }
  assert.match(summary(s, config, 160, null, theme).line, /1 轮 77 步 · 249 tok\/s/);
  const content = panelContent("tokens", s, config, statuses, 60).rows.join("\n");
  assert.match(content, /7,323,856 tok/); assert.match(content, /98\.7%/);
});
test("more hides reserved sources even with includeUnmapped and preserves full raw content", () => {
  const config = defaultFooterConfig(); config.more = { includeUnmapped: true, sections: [{ label: "状态", status: "mode" }, { label: "策略", status: "policy", hidden: true }] };
  const text = panelContent("more", emptySnapshot(), config, new Map([["mode", "full"], ["policy", "hidden text"], ["unknown", "no inferred severity\nlast line"]]), 50).rows.join("\n");
  assert.match(text, /状态\nfull/); assert.match(text, /last line/); assert.doesNotMatch(text, /hidden text|策略/);
});
test("unmeasured history and unsettled context explicitly show missing values", () => {
  const s = emptySnapshot(); s.steps = 5;
  assert.match(panelContent("stats", s, defaultFooterConfig(), new Map(), 60).rows.join("\n"), /计时覆盖 0\/5/);
  assert.match(panelContent("context", s, defaultFooterConfig(), new Map(), 60).rows.join("\n"), /待结算/);
});
