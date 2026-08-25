// Execution-intent extraction: what is the user asking the model to DO?
//
// Replaces the v0.12 `analysisOnly` boolean, which had a negation-scoping
// bug family:
//   "不要只分析，直接修改代码" → analysisOnly = true   (WRONG — it says mutate)
//   "批准，但是不要改数据库"     → released execution   (WRONG — constraint added)
//
// Design (v1.0 P0-2):
//   1. Split the prompt into clauses (punctuation + sequencing words).
//   2. Per clause, find mutation / read-only / ambiguous verbs using the
//      shared matcher (word boundaries for Latin, free for CJK).
//   3. A verb is NEGATED when a negator (不要/别/先别/don't …) appears in
//      the same clause shortly before it. Negated verbs are dead evidence.
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
  "fix", "implement", "refactor", "deploy", "migrate", "modify", "update",
  "patch", "rewrite", "bump", "install", "uninstall",
  // ZH
  "修改", "改动", "更改", "重构", "实现", "编写", "写", "写一个", "写个",
  "新增", "添加", "删除", "去掉", "创建", "更新", "升级", "部署", "迁移",
  "修复", "解决", "改成", "换成", "加上", "补上", "优化", "完善", "落地",
];

const READONLY_VERBS = [
  // EN
  "analyze", "analyse", "review", "explain", "investigate", "evaluate",
  "assess", "audit", "research", "compare", "summarize", "document",
  // ZH
  "分析", "审查", "评审", "解释", "解读", "调研", "研究", "评估", "对比",
  "检查", "排查", "定位", "审阅", "梳理", "总结",
];

// Ambiguous verbs ("帮我看看这个") yield NO signal → intent becomes
// "unclear". Deliberately not read-only: 看看 often precedes a fix request.
const AMBIGUOUS_VERBS = [
  "看看", "看下", "看一下", "瞧瞧", "试试", "试下",
  "look at", "check out", "take a look",
];

const NEGATORS = [
  "不要", "先别", "别", "不用", "无需", "不必", "不能", "不可以", "禁止",
  "切勿", "不准", "don't", "do not", "cannot", "can't", "no need to",
  "avoid",
];

// Chars allowed between a negator and its verb (只分析 / 先改 / 直接动手).
const INTERSTITIAL_RE = /^[只先再直接马上立即顺便帮]{0,6}$/;

const CLAUSE_SPLIT_RE = /[，。；、！？!?,;\n\r]+|\s+(?:然后|接着|再|and then|but)\s+/i;

function splitClauses(text) {
  return String(text ?? "")
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** True when a negator sits within the interstitial window before idx. */
function isNegated(clause, verbIdx) {
  const prefix = clause.slice(0, verbIdx);
  for (const neg of NEGATORS) {
    const at = prefix.toLowerCase().lastIndexOf(neg);
    if (at === -1) continue;
    const gap = prefix.slice(at + neg.length);
    if (gap.length <= 8 && INTERSTITIAL_RE.test(gap)) return true;
  }
  return false;
}

// When a mutation verb is immediately followed by one of these,
// it's a TOPIC MENTION / NARRATION ("迁移方案的风险", "README 里写了什么")
// not an action request — per "Intent beats mention":
//   分析一下迁移方案的风险 ≠ 帮我做迁移
//   README 里写了什么       ≠ 帮我写
const NOUN_SUFFIXES = [
  "方案", "计划", "文档", "记录", "说明", "报告", "清单", "列表",
  "流程", "日志", "历史", "指南", "手册",
  "plan", "report", "doc", "notes", "list", "guide",
];

function isTopicMention(lower, hit) {
  const after = lower.slice(hit.end, hit.end + 8);
  // Completed-aspect marker: verb+了 / verb+过 narrates existing state.
  if (after.startsWith("了") || after.startsWith("过")) return true;
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
 * Examples (all verified in self-test):
 *   只分析，不要修改            → read-only
 *   不要只分析，直接修改代码     → mutate      (negation scoping fixed)
 *   帮我修复这个 bug           → mutate
 *   先分析问题，然后修改         → mutate      (later clause wins)
 *   帮我看看这个                → unclear     (ambiguous verb)
 *   批准，但是不要改数据库       → mutate*     (*see approval.js for the
 *                                            plan-response classifier)
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

/**
 * Imperative-frame extraction (v1.0 P0-4 companion): what ACTION is the
 * user requesting, and about WHAT? Used by the classifier to weight
 * "user asks to do X" far above "prompt mentions X".
 *
 * Returns { action, targetHint } where action ∈
 *   "modify" | "create" | "debug" | "review" | "research" | "explain" | null
 * and targetHint is the ~10 chars right after the action verb (raw text,
 * for domain/task correlation), or null.
 *
 * Only the FIRST clause is inspected: the imperative frame lives where the
 * request starts, not in background narration.
 */
export function extractIntentFrame(prompt) {
  const clauses = splitClauses(prompt);
  const first = clauses[0] ?? "";
  const lower = first.toLowerCase();

  const FRAME_ACTIONS = [
    { id: "debug", terms: ["排查", "定位", "修 bug", "修这个 bug", "debug", "why does ... fail"] },
    { id: "modify", terms: ["修改", "改动", "更改", "更新", "重构", "改成", "换成", "优化", "完善", "modify", "update", "change", "refactor", "fix"] },
    { id: "create", terms: ["新建", "创建", "编写", "写一个", "加一个", "新增", "添加", "create", "add", "write", "implement"] },
    { id: "review", terms: ["审查", "评审", "review"] },
    { id: "research", terms: ["调研", "研究", "对比", "compare", "investigate", "research"] },
    { id: "explain", terms: ["解释", "说明", "讲讲", "explain", "how does"] },
  ];

  for (const { id, terms } of FRAME_ACTIONS) {
    const hits = findTerms(lower, terms);
    if (hits.length === 0) continue;
    const hit = hits[0];
    const targetHint = lower.slice(hit.end, hit.end + 20).trim() || null;
    return { action: id, targetHint, frameFound: true };
  }
  return { action: null, targetHint: null, frameFound: false };
}
