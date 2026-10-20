import assert from "node:assert/strict";
import test from "node:test";
import { PANEL_HEADER_ROW, PANEL_PADDING, panelCloseButton, panelContent, panelLines, panelText, summary } from "../render.ts";
import { defaultFooterConfig } from "../config.ts";
import { emptySnapshot } from "../types.ts";
import { visibleWidth } from "../layout.ts";
import { wrapWords } from "../wrapping.ts";
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
  assert.equal(stats.length, 14); assert.doesNotMatch(stats.join("\n"), /Esc|端到端|并行|\[x\]/);
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
  assert.match(text, /OC 5h: 6% \(49m\)\n +week: 4% \(138h15m\)\n +month: 8% \(451h52m\)/);
});
test("all four corner cells receive the same complete surface as the card body", () => {
  const t = { ...theme, style: (text: string, options: any) => options.bg ? `<surface>${text}</surface>` : text };
  for (const icons of ["unicode", "ascii"] as const) {
    const c = defaultFooterConfig(); c.icons = icons;
    const lines = panelLines("stats", emptySnapshot(), c, new Map(), 60, 24, 0, t).lines;
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(line.startsWith("<surface>") && line.endsWith("</surface>"), line);
  }
});
test("multiline values keep one right edge with the label beside the first line", () => {
  const c = defaultFooterConfig(); c.more.sections = [{ label: "额度", status: "quota" }];
  const text = plain("more", emptySnapshot(), c, new Map([["quota", "OC 5h: 6% (49m) week: 4% (138h15m) month: 8% (451h52m)"]]), 52);
  const rows = text.split("\n").filter(line => /49m|138h15m|451h52m/.test(line));
  assert.equal(rows.length, 3); assert.match(rows[0], /^额度 +OC/);
  for (const row of rows) assert.equal(visibleWidth(row), 52);
});
test("a diagnostic paragraph has one label and compact continuations on a stable left edge", () => {
  const c = defaultFooterConfig(); c.more.sections = [{ label: "诊断", status: "diagnostics" }];
  const value = "LSP Active: python, marksman, typos, ast-grep, opengrep";
  const rows = panelContent("more", emptySnapshot(), c, new Map([["diagnostics", value]]), 52).rows;
  const end = rows.findIndex(row => !row.length), paragraph = rows.slice(0, end);
  assert.equal(paragraph.length, 2);
  assert.equal(paragraph.flat().filter(part => part.text === "诊断").length, 1);
  assert.equal(paragraph.map(row => row.find(part => part.tone === "value")!.text).join(" "), value);
  for (const row of paragraph) {
    const index = row.findIndex(part => part.tone === "value");
    assert.equal(visibleWidth(row.slice(0, index).map(part => part.text).join("")), 7);
    assert.equal(visibleWidth(row.map(part => part.text).join("")), 52);
  }
  assert.deepEqual(rows[end], []); // Field spacing stays separate from paragraph wrapping.
});
test("comma lists wrap at item boundaries and mixed long text retains every grapheme", () => {
  const names = ["python", "marksman", "typos", "ast-grep", "opengrep"];
  const compact = names.join(",");
  const lines = wrapWords(compact, 18);
  assert.equal(lines.join(""), compact);
  for (const name of names) assert.ok(lines.some(line => line.includes(name)), name);
  const c = defaultFooterConfig(); c.more.sections = [{ label: "诊断", status: "diagnostics" }];
  const value = `LSP Active: ${compact}；中文诊断、🚀分析器，${"unbroken".repeat(40)}`;
  for (const width of [12, 20, 36, 52, 92]) {
    const rows = panelContent("more", emptySnapshot(), c, new Map([["diagnostics", value]]), width).rows;
    const end = rows.findIndex(row => row.some(part => part.tone === "rule"));
    const values = rows.slice(0, end).flat().filter(part => part.tone === "value").map(part => part.text);
    assert.equal(values.join("").replace(/\s/gu, ""), value.replace(/\s/gu, ""));
    assert.ok(values.every(text => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)));
    for (const row of rows) assert.ok(visibleWidth(row.map(part => part.text).join("")) <= width);
  }
});
test("large diagnostic lists remain scrollable inside fixed card bounds with the tail reachable", () => {
  const c = defaultFooterConfig(); c.more.sections = [{ label: "诊断", status: "diagnostics" }];
  const s = emptySnapshot(); s.model = "end-model"; s.provider = "end-provider";
  const value = "LSP Active: " + Array.from({ length: 200 }, (_, i) => `server-${i}`).join(", ");
  const statuses = new Map([["diagnostics", value]]);
  for (const width of [28, 40, 60, 100]) for (const height of [10, 16, 24]) {
    const first = panelLines("more", s, c, statuses, width, height, 0, theme);
    const last = panelLines("more", s, c, statuses, width, height, Number.MAX_SAFE_INTEGER, theme);
    assert.ok(first.maxOffset > 0);
    for (const card of [first, last]) {
      assert.equal(card.lines.length, height);
      assert.match(card.lines[PANEL_HEADER_ROW], /更多.*ｘ/);
      assert.ok(card.lines.every(line => visibleWidth(line) === width));
      assert.match(card.lines.join("\n"), /滚轮查看更多|…/);
    }
    assert.match(last.lines.join("\n"), /end-provider/);
  }
});
test("comfortable spacing stays bounded at every supported card height", () => {
  const s = emptySnapshot(), c = defaultFooterConfig();
  for (let height = 1; height <= 32; height++) {
    for (const id of ["stats", "tokens", "context", "more"] as const) {
      const result = panelLines(id, s, c, new Map(), 60, height, 0, theme);
      assert.ok(result.lines.length <= height, `${id}: ${height}`);
    }
  }
  const lines = panelLines("stats", s, c, new Map(), 60, 30, 0, theme).lines;
  const index = lines.findIndex(line => line.includes("模型用时"));
  assert.match(lines[index + 1], /^│ +│$/); assert.match(lines[index + 2], /工具用时/);
  assert.match(lines[1], /^│ +│$/); assert.match(lines.at(-2)!, /^│ +│$/);
});

test("square close glyph shares title weight and the right edge of values on every card", () => {
  const bolded: string[] = [];
  const t = { ...theme, bold: (text: string) => { bolded.push(text); return text; } };
  for (const icons of ["unicode", "ascii"] as const) for (const width of [32, 54, 60, 80]) {
    const c = defaultFooterConfig(); c.icons = icons;
    const button = panelCloseButton(width, icons);
    assert.equal(button.glyph, icons === "ascii" ? "x" : "ｘ");
    assert.equal(button.width, icons === "ascii" ? 1 : 2);
    for (const id of ["stats", "tokens", "context", "more"] as const) {
      const rows = panelLines(id, emptySnapshot(), c, new Map(), width, 30, 0, t).lines;
      const header = rows[PANEL_HEADER_ROW], right = width - 1 - PANEL_PADDING;
      assert.equal(visibleWidth(header.slice(0, header.indexOf(button.glyph))), button.column);
      assert.equal(button.column + button.width, right);
      assert.equal(visibleWidth(header.replace(/[ |│]+$/, "")), right);
      for (const line of rows.filter(line => /模型用时|未缓存输入|提供方/.test(line))) assert.equal(visibleWidth(line.replace(/[ |│]+$/, "")), right);
      assert.equal(rows.filter(row => row.includes(button.glyph)).length, 1);
    }
  }
  assert.ok(bolded.includes("会话统计")); assert.ok(bolded.includes("ｘ"));
});
