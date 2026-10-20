import assert from "node:assert/strict";
import test from "node:test";
import { panelContent, panelLines, panelText, summary } from "../render.ts";
import { defaultFooterConfig } from "../config.ts";
import { emptySnapshot } from "../types.ts";
import { visibleWidth } from "../layout.ts";
const plain = (...args: Parameters<typeof panelContent>) => panelText(panelContent(...args));
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
  const content = plain("tokens", s, config, statuses, 60);
  assert.match(content, /7,323,856 tok/); assert.match(content, /98\.7%/);
});
test("more hides reserved sources even with includeUnmapped and preserves full raw content", () => {
  const config = defaultFooterConfig(); config.more = { includeUnmapped: true, sections: [{ label: "状态", status: "mode" }, { label: "策略", status: "policy", hidden: true }] };
  const text = plain("more", emptySnapshot(), config, new Map([["mode", "full"], ["policy", "hidden text"], ["unknown", "no inferred severity\nlast line"]]), 50);
  assert.match(text, /状态 +full/); assert.match(text, /last line/); assert.doesNotMatch(text, /hidden text|策略/);
});
test("unmeasured history and unsettled context explicitly show missing values", () => {
  const s = emptySnapshot(); s.steps = 5;
  assert.match(plain("stats", s, defaultFooterConfig(), new Map(), 60), /计时覆盖 0\/5/);
  assert.match(plain("context", s, defaultFooterConfig(), new Map(), 60), /待结算/);
});
test("selection never fills a background and preserves segment positions", () => {
  let styled = 0;
  const t = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, style: (text: string) => { styled++; return text; } };
  const config = defaultFooterConfig();
  const off = summary(emptySnapshot(), config, 120, null, t), on = summary(emptySnapshot(), config, 120, "stats", t);
  assert.equal(styled, 0); assert.deepEqual(on.hits, off.hits);
  assert.match(on.line, /<text>◴/); assert.match(on.line, /<muted>▱/);
});
test("cards separate label/value tones, keep total in the header and omit persistent help", () => {
  const s = emptySnapshot(); s.usage.input = 1000;
  const t = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };
  const stats = panelLines("stats", s, defaultFooterConfig(), new Map(), 54, 24, 0, theme).lines;
  assert.equal(stats.length, 8); assert.doesNotMatch(stats.join("\n"), /Esc|端到端|并行|\[x\]/);
  const tokens = panelLines("tokens", s, defaultFooterConfig(), new Map(), 54, 24, 0, t).lines.join("\n");
  assert.match(tokens, /Token 用量.*1,000 tok/);
  assert.match(tokens, /\[muted\]未缓存输入/); assert.match(tokens, /\[text\]1,000 tok/);
  assert.equal(tokens.match(/Token 用量/g)?.length, 1);
});
test("neutral surface follows light/dark appearance and never uses a message background", () => {
  for (const appearance of ["dark", "light"] as const) {
    const colors: any[] = [];
    const t = { ...theme, appearance, style: (text: string, options: any) => { colors.push(options); return text; } };
    panelLines("stats", emptySnapshot(), defaultFooterConfig(), new Map(), 54, 24, 0, t);
    const color = colors.find(options => options.bg)?.bg;
    assert.equal(color.kind, "rgb"); assert.ok(Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) < 10);
    assert.equal(color.r > 128, appearance === "light");
  }
});
test("more is compact and never exposes implementation keys even with catch-all enabled", () => {
  const c = defaultFooterConfig(); c.more = { includeUnmapped: true, sections: [{ label: "状态", status: "access:key" }, { label: "诊断", status: "lsp:key" }] };
  const text = plain("more", emptySnapshot(), c, new Map([["access:key", "完全访问权限"], ["lsp:key", "LSP Inactive"], ["context:internal", "Context 0%"]]), 48);
  assert.match(text, /状态 +完全访问权限/); assert.match(text, /诊断 +LSP Inactive/);
  assert.doesNotMatch(text, /access:key|lsp:key|context:internal|就绪|尚未配置|config\.json/);
});
test("long status prose wraps at visual separators without splitting qualifier groups", () => {
  const c = defaultFooterConfig(); c.more.sections = [{ label: "额度", status: "quota" }];
  const value = "OC 5h: 6% (49m) week: 4% (138h15m) month: 8% (451h52m)";
  const text = plain("more", emptySnapshot(), c, new Map([["quota", value]]), 48);
  assert.match(text, /OC 5h: 6% \(49m\)\n  week: 4% \(138h15m\)\n  month: 8% \(451h52m\)/);
});
