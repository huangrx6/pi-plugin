// Execution-intent extraction: what is the user asking the model to DO?
//
// Replaces the v0.12 `analysisOnly` boolean, which had a negation-scoping
// bug family:
//   "不要只分析，直接修改代码" → analysisOnly = true   (WRONG — it says mutate)
//   "批准，但是不要改数据库"     → released execution   (WRONG — constraint added)
//
// Design (v1.0 P0-2, hardened in v0.16):
//   1. Split the prompt into clauses (punctuation + sequencing words).
//   2. Per clause, find mutation / read-only / ambiguous verbs using the
//      shared matcher (word boundaries for Latin, free for CJK).
//   3. A verb is NEGATED when a negator (不要/别/先别/don't …) appears in
//      the same clause shortly before it, allowing only interstitial words
//      (只/先/just/only/…) between them. Negated verbs are dead evidence.
//      v0.16 fix: the interstitial window now tolerates spaces, so
//      "do not fix", "dont fix", and "不要 修改" are all recognized.
//   4. Decision:
//        any live mutation clause          → "mutate"
//        else any live read-only clause    → "read-only"
//        else                              → "unclear"
//
// The three-value result matters downstream:
//   requiresApproval = rigor === "strict" && intent === "mutate"
// "unclear" deliberately does NOT release strict execution.

import { findTerms } from "./matcher.js";

const MUTATION_VERBS = [
  // EN
  "fix",
  "implement",
  "refactor",
  "deploy",
  "migrate",
  "modify",
  "update",
  "patch",
  "rewrite",
  "bump",
  "install",
  "uninstall",
  "write",
  "create",
  "add",
  "remove",
  "delete",
  // ZH (bare 改/删 are safe: longest-match-wins subsumes 修改/改动/删库 …)
  "改",
  "修改",
  "改动",
  "更改",
  "重构",
  "实现",
  "编写",
  "写",
  "写一个",
  "写个",
  "新增",
  "添加",
  "删除",
  "删",
  "去掉",
  "创建",
  "更新",
  "升级",
  "部署",
  "迁移",
  "修复",
  "解决",
  "调整",
  "改成",
  "换成",
  "加上",
  "补上",
  "优化",
  "完善",
  "落地",
];

const READONLY_VERBS = [
  // EN
  "analyze",
  "analyse",
  "review",
  "explain",
  "investigate",
  "evaluate",
  "assess",
  "audit",
  "research",
  "compare",
  "summarize",
  "document",
  // ZH
  "分析",
  "审查",
  "评审",
  "解释",
  "解读",
  "调研",
  "研究",
  "评估",
  "对比",
  "检查",
  "排查",
  "定位",
  "审阅",
  "梳理",
  "总结",
];

// Ambiguous verbs ("帮我看看这个") yield NO signal → intent becomes
// "unclear". Deliberately not read-only: 看看 often precedes a fix request.
const AMBIGUOUS_VERBS = [
  "看看",
  "看下",
  "看一下",
  "瞧瞧",
  "试试",
  "试下",
  "look at",
  "check out",
  "take a look",
];

const NEGATORS = [
  // ZH
  "不要",
  "先别",
  "别",
  "不用",
  "不需要",
  "无须",
  "无需",
  "不必",
  "不能",
  "不可以",
  "禁止",
  "切勿",
  "不准",
  // EN (apostrophe and split forms both; "dont" for lazy typers)
  "don't",
  "dont",
  "do not",
  "cannot",
  "can't",
  "can not",
  "should not",
  "shouldn't",
  "must not",
  "mustn't",
  "will not",
  "won't",
  "no need to",
  "never",
  "avoid",
];

// CJK chars allowed between a negator and its verb (只分析 / 先改 / 直接动手).
const INTERSTITIAL_CJK_RE = /^[只先再直接马上立即顺便帮的]{0,6}$/;

// EN words allowed between a negator and its verb ("don't JUST fix").
const INTERSTITIAL_EN_RE =
  /^(?:just|only|directly|please|simply|then|now|go|and|to|it)(?:\s+(?:just|only|directly|please|simply|then|now|go|and|to|it))*$/i;

const CLAUSE_SPLIT_RE =
  /[，。；、！？!?,;\n\r]+|\s+(?:然后|接着|再|and then|but)\s+/i;

function splitClauses(text) {
  return String(text ?? "")
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * True when the gap between a negator and its verb consists only of
 * interstitial words/particles (spaces tolerated since v0.16).
 */
function isInterstitial(gapRaw) {
  const g = gapRaw.trim().replace(/[\s,、]+/g, (m) => (m.includes("\n") ? "\n" : " "));
  const compact = g.replace(/\s+/g, "");
  if (!compact) return true;
  if (INTERSTITIAL_CJK_RE.test(compact)) return true;
  return INTERSTITIAL_EN_RE.test(g);
}

/** True when a negator sits within the interstitial window before idx. */
function isNegated(clause, verbIdx) {
  const prefix = clause.slice(0, verbIdx);
  for (const neg of NEGATORS) {
    const at = prefix.toLowerCase().lastIndexOf(neg);
    if (at === -1) continue;
    const gap = prefix.slice(at + neg.length);
    if (gap.length <= 16 && isInterstitial(gap)) return true;
  }
  return false;
}

// When a mutation verb is immediately followed by one of these,
// it's a TOPIC MENTION / NARRATION ("迁移方案的风险") not an action
// request — per "Intent beats mention":
//   分析一下迁移方案的风险 ≠ 帮我做迁移
// v0.16: narrowed to the VERIFIED bug family (方案/计划 compound nouns).
// Object-nouns like 文档 ("更新文档" = update the docs) must stay LIVE —
// the old list killed them and broke the intent frame.
const NOUN_SUFFIXES = [
  "方案",
  "计划",
  "plan",
  "report",
];

function isTopicMention(lower, hit) {
  const after = lower.slice(hit.end, hit.end + 8);
  // Completed/copicula markers: verb+了 / verb+过 / verb+的是 narrate
  // existing state, they don't request it.
  if (
    after.startsWith("了") ||
    after.startsWith("过") ||
    after.startsWith("的是")
  ) {
    return true;
  }
  return NOUN_SUFFIXES.some((s) => after.startsWith(s));
}

/**
 * Classify one clause: "mutate" | "read-only" | null.
 * Negated verbs don't count; a negated mutation counts as weak evidence
 * that the user wants action elsewhere, but never as permission itself.
 */
function classifyClause(clause) {
  const lower = clause.toLowerCase();
  const mutHits = findTerms(lower, MUTATION_VERBS).filter(
    (h) => !isNegated(clause, h.idx) && !isTopicMention(lower, h),
  );
  if (mutHits.length > 0) {
    return { verdict: "mutate", via: mutHits[0].term };
  }
  const roHits = findTerms(lower, READONLY_VERBS).filter(
    (h) => !isNegated(clause, h.idx),
  );
  if (roHits.length > 0) {
    return { verdict: "read-only", via: roHits[0].term };
  }
  const ambHits = findTerms(lower, AMBIGUOUS_VERBS);
  if (ambHits.length > 0) {
    return { verdict: null, via: ambHits[0].term, ambiguous: true };
  }
  return { verdict: null };
}

/**
 * Extract the execution intent of a prompt.
 *
 * @returns {"read-only" | "mutate" | "unclear"}
 *
 * Examples (all verified in tests/regression-corpus.json):
 *   只分析，不要修改            → read-only
 *   不要只分析，直接修改代码     → mutate      (negation scoping fixed)
 *   don't fix it, just analyze  → read-only   (v0.16 space-gap fix)
 *   帮我修复这个 bug           → mutate
 *   先分析问题，然后修改         → mutate      (later clause wins)
 *   帮我看看这个                → unclear     (ambiguous verb)
 */
export function extractExecutionIntent(prompt) {
  const clauses = splitClauses(prompt);
  let sawReadonly = false;
  for (const clause of clauses) {
    const { verdict } = classifyClause(clause);
    if (verdict === "mutate") return "mutate";
    if (verdict === "read-only") sawReadonly = true;
  }
  return sawReadonly ? "read-only" : "unclear";
}

// ---------------------------------------------------------------------------
// Intent frame (v0.16: multi-clause, imperative-first)
// ---------------------------------------------------------------------------

// Clauses carrying one of these read as an explicit REQUEST, not narration.
const IMPERATIVE_MARKER_RE =
  /(帮我|帮忙|请|麻烦|现在|需要|我要|我想|能不能|可不可以|给我|let's|please|now|need to|i want|i need|can you)/i;

const FRAME_ACTIONS = [
  {
    id: "debug",
    terms: [
      "排查",
      "定位",
      "修复",
      "修 bug",
      "debug",
      "fix",
      "为什么",
      "troubleshoot",
    ],
  },
  {
    id: "modify",
    terms: [
      "改",
      "修改",
      "改动",
      "更改",
      "更新",
      "重构",
      "调整",
      "改成",
      "换成",
      "优化",
      "完善",
      "修复",
      "modify",
      "update",
      "change",
      "refactor",
      "fix",
      "patch",
    ],
  },
  {
    id: "create",
    terms: [
      "新建",
      "创建",
      "编写",
      "写",
      "写一个",
      "写个",
      "加一个",
      "新增",
      "添加",
      "create",
      "add",
      "write",
      "implement",
    ],
  },
  { id: "review", terms: ["审查", "评审", "review", "reviewing"] },
  {
    id: "research",
    terms: [
      "调研",
      "研究",
      "分析",
      "对比",
      "compare",
      "investigate",
      "research",
      "analyze",
    ],
  },
  { id: "explain", terms: ["解释", "讲讲", "explain", "how does"] },
];

/**
 * Imperative-frame extraction: what ACTION is the user requesting, and
 * about WHAT? Used by the classifier to weight "user asks to do X" far
 * above "prompt mentions X" (Intent beats mention).
 *
 * v0.16: scans ALL clauses instead of just the first. Real prompts front-
 * load background ("README 里以前写的是……，现在帮我把这段文档改准确") —
 * the imperative frame lives later. Selection order:
 *   1. clauses with an imperative marker (帮我/请/需要/please …)
 *   2. among equals, the LAST one wins (corrections supersede earlier asks)
 *   3. negated / topic-mention verbs never form a frame
 *
 * @returns { action, targetHint, frameFound, frameClause }
 *   action ∈ "modify" | "create" | "debug" | "review" | "research" |
 *            "explain" | null
 */
export function extractIntentFrame(prompt) {
  const clauses = splitClauses(prompt);
  const candidates = [];

  clauses.forEach((clause, i) => {
    const lower = clause.toLowerCase();
    for (const { id, terms } of FRAME_ACTIONS) {
      const hits = findTerms(lower, terms);
      if (hits.length === 0) continue;
      const hit = hits[0];
      if (isNegated(clause, hit.idx)) continue;
      if (isTopicMention(lower, hit)) continue;
      candidates.push({
        action: id,
        targetHint: lower.slice(hit.end, hit.end + 20).trim() || null,
        frameClause: lower,
        clauseIdx: i,
        imperative: IMPERATIVE_MARKER_RE.test(clause),
      });
      break; // first live action verb in this clause
    }
  });

  if (candidates.length === 0) {
    return { action: null, targetHint: null, frameFound: false, frameClause: null };
  }
  const imperative = candidates.filter((c) => c.imperative);
  const pick = imperative.length > 0
    ? imperative[imperative.length - 1]
    : candidates[candidates.length - 1];
  return {
    action: pick.action,
    targetHint: pick.targetHint,
    frameFound: true,
    frameClause: pick.frameClause,
  };
}
