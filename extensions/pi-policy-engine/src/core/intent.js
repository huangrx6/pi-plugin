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
        "change",
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
        "实施",
        "执行",
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
        const g = gapRaw
                .trim()
                .replace(/[\s,、]+/g, (m) => (m.includes("\n") ? "\n" : " "));
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

// --- Action modality (v0.17): DIRECT vs ADVISORY -------------------------
//
// "告诉我如何修复" and "帮我修复" both contain 修复, but only the second
// asks the agent to DO it. Public enum stays read-only/mutate/unclear;
// this is an internal modality layer:
//   DIRECT mutation            → mutate
//   ADVISORY mutation          → read-only   (guidance is requested)
//   negated / past narration   → dead evidence
//
// Three advisory detectors (verified family, NOT open-ended suffix
// patching):
//   1. clause-initial communication verbs — 告诉我/解释/建议/show me…
//   2. interrogatives anywhere before the verb — 怎么/如何/how to…
//   3. plan-noun compounds right after the verb — 部署步骤/修复方案

// Optional politeness prefix before a clause-initial advisory verb.
const ADVISORY_HEAD_RE =
        /^(?:请|麻烦|帮我|先|顺便|现在|只|就)?\s*(?:告诉我|请教|讲讲|说说|解释|建议|show me|explain(?:\s+to\s+me)?|suggest|teach me|walk me through)/i;

// Interrogative scope: "how"-style markers earlier in the clause make any
// following mutation verb a discussed action (怎么修改 ≠ 修改).
const ADVISORY_BEFORE_RE =
        /(怎么|如何|how to|how do|how can|how should|what should)/i;

// Completed-aspect narration: verb+了/过 narrates existing state — DEAD
// evidence, no signal either way ("README 里写了什么" asks nothing).
function isPastNarration(lower, hit) {
        const after = lower.slice(hit.end, hit.end + 2);
        return after.startsWith("了") || after.startsWith("过");
}

// Plan-noun compound: the verb names a DOCUMENT/PLAN being discussed, not
// a requested action (部署步骤 = deployment STEPS, 修复方案 = fix PLAN).
// Object-nouns like 文档 ("更新文档" = update the docs) stay LIVE.
// A bare plan-noun ("设计迁移方案") is a discussed TOPIC — dead evidence;
// it only becomes advisory when the clause asks for it to be communicated
// (给我部署步骤 / 告诉我修复方案).
const ADVISORY_NOUNS = ["方案", "计划", "步骤", "plan", "steps"];

// Communication frame: the user asks to be HANDED guidance, not shown a change.
const COMMUNICATION_RE =
        /(告诉我|给我|讲讲|说说|请教|show me|give me|send me)/i;

function isAdvisoryNoun(lower, hit) {
        const after = lower.slice(hit.end, hit.end + 8);
        return ADVISORY_NOUNS.some((s) => after.startsWith(s));
}

/** Modality of one mutation-verb hit: "live" | "advisory" | "dead". */
function modality(clause, lower, hit) {
        if (isPastNarration(lower, hit)) return "dead";
        if (ADVISORY_HEAD_RE.test(clause.trim())) return "advisory";
        if (ADVISORY_BEFORE_RE.test(lower.slice(0, hit.idx))) return "advisory";
        if (isAdvisoryNoun(lower, hit)) {
                return COMMUNICATION_RE.test(clause) ? "advisory" : "dead";
        }
        return "live";
}

/**
 * Classify one clause into a KIND used by sequential resolution:
 *   "mutate"             live mutation verb
 *   "read-only"          live read-only verb OR advisory mutation
 *                       (guidance request) OR communication head
 *   "negated-mutate"     a mutation verb was explicitly revoked here
 *   "negated-read-only"  a read-only verb was explicitly revoked here
 *   null                 no signal (ambiguous/narration/bare topic)
 */
/**
 * Scoped negation (v0.21): "不要改数据库" / "don't touch the schema" attach
 * a TARGET to the negated verb — that is a scope CONSTRAINT on an otherwise
 * live task, not a global revocation. "修复 bug，但不要改数据库" must stay
 * mutate. A BARE negated verb ("不要修改" / "先别改") carries no target and
 * revokes globally. Pronouns/quantifiers (任何/所有/it/anything) do not
 * count as targets.
 */
function isScopedNegation(lower, hit) {
        const after = lower.slice(hit.end, hit.end + 8).replace(/^[\s的]+/, "");
        if (!after) return false;
        if (/^(?:任何|所有|每)/.test(after)) return false;
        if (/^(?:it|them|anything|everything|any |all )/i.test(after)) {
                return false;
        }
        return /^[\p{L}\p{N}_]/u.test(after);
}

// Planning deliverables (v0.21): the DESIGN/PLAN ITSELF is the requested
// product — "帮我设计一个微服务迁移方案" / "规划一下迁移步骤". Default
// read-only; an implementation marker in the SAME clause ("并实施"/"并实现"
// / apply it) keeps it a live mutation task.
const PLANNING_DELIVERABLE_RE =
        /(设计|规划|制定|起草|草拟|拟一个|梳理)(?:一[个份套下点])?|(?<!不)(?:给我|出)[^，。;；]{0,8}(方案|计划|步骤|路线图)/;
const IMPLEMENT_MARKER_RE =
        /(并实施|并执行|并实现|以及实施|和实施|然后实施|然后实现|然后落地|直接落地|顺便实施|apply it|implement it|and implement|then implement)/i;

function isPlanningDeliverable(clause) {
        if (!PLANNING_DELIVERABLE_RE.test(clause)) return false;
        return !IMPLEMENT_MARKER_RE.test(clause);
}

// Hypothetical frame (v0.22, fixed v0.23): the mutation is DISCUSSED, not
// requested. The trigger is a CONSEQUENCE QUESTION sharing the clause with
// the verb — "删除这个文件会有什么影响" / "为什么要修改这个文件" / "what
// happens if X". A bare conditional (如果/假如/要是) is NOT hypothetical:
// "如果测试通过就部署" is a conditional EXECUTION instruction, and making
// 如果 alone trigger read-only made intent depend on whether the user
// typed a comma ("如果测试通过，就部署" split into clauses → mutate, the
// unsplit version read-only — verified inconsistency).
const HYPOTHETICAL_RE =
        /(会发生什么|会怎么样|会怎样|有什么影响|有什么后果|有什么风险|为什么要|what (?:happens|would happen)|what are the (?:risks?|impacts?|consequences)|why (?:would|should|do|does))/i;

// Broad revoke verbs (v0.23): a negated 改/修改/动/做/执行 revokes the
// WHOLE task ("先修改代码，不要修改" → read-only analysis follows). A
// negated SPECIFIC verb (不要重构/不要部署/不要迁移/不要安装/不要优化…) is
// an implementation CONSTRAINT on an otherwise-live task: "修复这个 bug，但
// 不要重构" stays mutate — the specific verb is itself the scope, no
// target noun needed ("不要更新依赖" also worked before only because 依赖
// parsed as a target; "不要重构" has none and was misread as a revoke).
const BROAD_REVOKE_TERMS = new Set([
        "改",
        "修改",
        "改动",
        "更改",
        "动",
        "做",
        "执行",
        "实施",
        "change",
        "modify",
        "do",
        "execute",
        "implement",
        "touch",
]);

function isBroadRevoke(term) {
        return BROAD_REVOKE_TERMS.has(term);
}

function classifyClause(clause) {
        const lower = clause.toLowerCase();
        // Planning deliverable first (v0.21): when the plan itself is the
        // product, the clause is a read-only request — UNLESS the clause
        // also carries an implementation marker (checked above).
        if (isPlanningDeliverable(clause)) {
                return { kind: "read-only", via: "planning-deliverable" };
        }
        const hypothetical = HYPOTHETICAL_RE.test(clause);
        // Conditional-headed approval phrase ("如果确认后再执行") DISCUSSES
        // the gate — same modality as the v0.22 approval-hypothetical skip,
        // applied to intent so the split clause ("，会发生什么？") doesn't
        // leave a stray live 执行. "如果测试通过就部署" (no approval phrase)
        // is unaffected and stays a conditional execution instruction.
        const conditionalApprovalTalk =
                /^(如果|假如|假设|要是|万一)/.test(clause.trim()) &&
                DEFERRED_APPROVAL_RE.test(clause);
        const liveMut = [];
        const advisoryMut = [];
        let negatedMut = false;
        for (const h of findTerms(lower, MUTATION_VERBS)) {
                if (isNegated(clause, h.idx)) {
                        // Global revocation requires a BROAD verb with no
                        // attached target (v0.23). Specific verbs (重构/
                        // 部署/删除…) and targeted negations are scope
                        // constraints — the task stays live.
                        if (
                                isBroadRevoke(h.term) &&
                                !isScopedNegation(lower, h)
                        ) {
                                negatedMut = true;
                        }
                        continue;
                }
                const m = modality(clause, lower, h);
                if (m === "live") {
                        // Hypothetical mutations are discussed consequences —
                        // they read as read-only questions, not requests.
                        if (hypothetical || conditionalApprovalTalk)
                                advisoryMut.push(h);
                        else liveMut.push(h);
                } else if (m === "advisory") advisoryMut.push(h);
                // "dead": narrated or bare topic mention — no signal either way.
        }
        if (liveMut.length > 0) {
                return { kind: "mutate", via: liveMut[0].term };
        }
        const roHits = findTerms(lower, READONLY_VERBS).filter(
                (h) => !isNegated(clause, h.idx),
        );
        // Advisory mutation (告诉我如何修复/给我部署步骤) IS a read-only
        // request: the user asks for guidance, not for the change itself.
        // A clause-initial communication head ("只告诉我原因") reads as
        // read-only even with no mutation verb in it.
        if (
                advisoryMut.length > 0 ||
                roHits.length > 0 ||
                ADVISORY_HEAD_RE.test(clause.trim())
        ) {
                return {
                        kind: "read-only",
                        via:
                                advisoryMut[0]?.term ??
                                roHits[0]?.term ??
                                "communication",
                };
        }
        if (negatedMut) return { kind: "negated-mutate" };
        if (roHits.length === 0) {
                // any readonly verb hit was filtered above; detect negation
                const anyRo = findTerms(lower, READONLY_VERBS);
                if (anyRo.length > 0) return { kind: "negated-read-only" };
        }
        const ambHits = findTerms(lower, AMBIGUOUS_VERBS);
        if (ambHits.length > 0) {
                return { kind: null, via: ambHits[0].term, ambiguous: true };
        }
        return { kind: null };
}

// Correction heads (v0.20 P0): the user revokes / supersedes what came
// before. A later correction must override an earlier request — the old
// "any live mutation short-circuits" let "先修改代码，不要修改，只分析"
// classify as mutate.
const CORRECTION_HEAD_RE =
        /^(不对|不对了|等等|等一下|算了|改主意|改为|改成|其实|实际上|重新说|说错了|说反了|换个思路|wrong|actually|instead|wait|scratch that|on second thought|never mind|hold on)/i;

/**
 * Extract the execution intent of a prompt via SEQUENTIAL clause
 * resolution (v0.20): the user's LAST effective instruction wins.
 *
 *   先修改代码 → active=mutate
 *   不要修改  → revokes mutate (negated-mutate clears an active mutate)
 *   只分析    → active=read-only
 *
 * Correction heads (不对/等等/算了/actually…) clear ANY active intent;
 * a negated clause only clears the SAME kind it negates ("只分析，不要
 * 修改" stays read-only — the negation targets mutation, not analysis).
 *
 * @returns {"read-only" | "mutate" | "unclear"}
 */
export function extractExecutionIntent(prompt) {
        return extractExecutionMeta(prompt).executionIntent;
}

// Explicit approval gate (v0.21 P0): the user states that execution happens
// only after their confirmation. "先别改，给我方案，确认后再执行" must land
// in the strict planning phase (approval gate), NOT auto-routed by risk.
// This outranks risk heuristics: an explicit user gate beats an implicit
// "medium risk → standard" guess.
const DEFERRED_APPROVAL_RE =
        /(确认|批准|同意|点头|okay|ok|approve[ds]?)[^，。;,]{0,6}(后|之后|再)[^，。;,]{0,8}(执行|做|改|动|动手|实施|落地|上线|继续|deploy|execute|apply|proceed)|等我(确认|批准|点头|同意)|待(我)?(确认|批准)后|after (i |you )?(confirm|approve|okay)|once (i |you )?(approve|confirm|okay)|wait for (my |your )?(approval|confirmation|okay|go.?ahead)/i;

// Approval-gate MODALITY (v0.22 P0): the phrase 确认后再执行 can be
// demanded, negated, asked about, or quoted — only a demand creates a
// gate. Verified failures of the bare whole-prompt regex:
//   "不需要确认后再执行，直接修改代码" → gate (WRONG — the user lifted it)
//   把 README 里的"确认后再执行"改成"确认后部署" → gate (WRONG — doc edit)
//   "如果确认后再执行，会发生什么？" → gate (WRONG — a question)
const APPROVAL_NEGATOR_RE =
        /(不需要?|不用|无需|不必|别)[^，。;,]{0,4}(等)?[^，。;,]{0,4}(确认|批准|审批|同意|点头|approval|confirmation|confirm)|no need (?:to wait|for|to)|don'?t (?:wait|need)|without (?:my |your )?(?:approval|confirmation)/i;
const APPROVAL_HYPOTHETICAL_RE =
        /^(如果|假如|假设|要是|万一)|会发生什么|会怎么样|会怎样|有什么影响|what (?:happens|would happen)/i;

// Quote masking (v0.23): the deferred-approval phrase must be matched in
// UNQUOTED text only. The v0.22 whole-clause quote skip was punctuation-
// sensitive: '先给我方案确认后再执行并把标题改成"foo"' dropped the gate
// merely because SOME quote existed in the clause, while the comma'd
// variant gated correctly. Masking quoted spans fixes both directions:
// 把"确认后再执行"改成"确认后部署" masks the phrase (no gate);
// 确认后再执行，字段叫"id" leaves the phrase live (gate).
const QUOTE_CHARS = "“”「」『』\"'";

function maskQuotedSpans(text) {
        let out = "";
        let inQuote = false;
        for (const ch of text) {
                if (QUOTE_CHARS.includes(ch)) {
                        inQuote = !inQuote;
                        out += "_";
                } else {
                        out += inQuote ? "_" : ch;
                }
        }
        return out;
}

/**
 * Classify whether the prompt DEMANDS an approval gate. Clause-wise, last
 * effective instruction wins: a negator LIFTS any prior gate; quoted,
 * hypothetical, or advisory mentions are ignored; a bare deferred-approval
 * phrase demands one.
 * @returns {"explicit" | null}
 */
export function classifyApprovalRequirement(prompt) {
        const clauses = splitClauses(prompt);
        let required = null;
        for (const clause of clauses) {
                const t = clause.trim();
                if (APPROVAL_NEGATOR_RE.test(t)) {
                        required = null; // "不用等我确认" lifts the gate
                        continue;
                }
                // Match only in unquoted spans (v0.23 quote-aware).
                const unquoted = maskQuotedSpans(t);
                if (!DEFERRED_APPROVAL_RE.test(unquoted)) continue;
                if (APPROVAL_HYPOTHETICAL_RE.test(t)) continue; // asking about it
                if (ADVISORY_HEAD_RE.test(t)) continue; // explain-it request
                required = "explicit";
        }
        return required;
}

/**
 * Full execution meta (v0.21): intent + timing + explicit approval.
 *
 * @returns { executionIntent, executionTiming: "now"|"deferred",
 *             approvalRequired: "explicit"|null }
 */
export function extractExecutionMeta(prompt) {
        const clauses = splitClauses(prompt);
        let active = null;
        for (const clause of clauses) {
                if (CORRECTION_HEAD_RE.test(clause.trim())) active = null;
                const { kind } = classifyClause(clause);
                if (kind === "mutate") active = "mutate";
                else if (kind === "read-only") active = "read-only";
                else if (kind === "negated-mutate") {
                        if (active === "mutate") active = null;
                } else if (kind === "negated-read-only") {
                        if (active === "read-only") active = null;
                }
        }
        const approvalRequired = classifyApprovalRequirement(prompt);
        // A deferred execution clause ("确认后再执行") reads as mutate via
        // the live 执行 verb, but its timing is deferred.
        const executionTiming =
                approvalRequired === "explicit" ? "deferred" : "now";
        return {
                executionIntent: active ?? "unclear",
                executionTiming,
                approvalRequired,
        };
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
        let lastCorrectionIdx = -1;

        clauses.forEach((clause, i) => {
                if (CORRECTION_HEAD_RE.test(clause.trim()))
                        lastCorrectionIdx = i;
                const lower = clause.toLowerCase();
                for (const { id, terms } of FRAME_ACTIONS) {
                        const hits = findTerms(lower, terms);
                        if (hits.length === 0) continue;
                        const hit = hits[0];
                        if (isNegated(clause, hit.idx)) continue;
                        // Skip narrated (写了) and plan-noun (部署步骤) verbs — but KEEP
                        // advisory-marker verbs (怎么修改文档): the discussed topic still
                        // anchors task routing even when the intent is read-only.
                        if (isPastNarration(lower, hit)) continue;
                        if (isAdvisoryNoun(lower, hit)) continue;
                        candidates.push({
                                action: id,
                                targetHint:
                                        lower
                                                .slice(hit.end, hit.end + 20)
                                                .trim() || null,
                                frameClause: lower,
                                clauseIdx: i,
                                imperative: IMPERATIVE_MARKER_RE.test(clause),
                        });
                        break; // first live action verb in this clause
                }
        });

        // v0.20: a correction supersedes everything before it — candidates
        // from clauses BEFORE the last correction head are dead.
        const effective = candidates.filter(
                (c) => c.clauseIdx > lastCorrectionIdx,
        );
        if (effective.length === 0) {
                return {
                        action: null,
                        targetHint: null,
                        frameFound: false,
                        frameClause: null,
                };
        }
        const imperative = effective.filter((c) => c.imperative);
        const pick =
                imperative.length > 0
                        ? imperative[imperative.length - 1]
                        : effective[effective.length - 1];
        return {
                action: pick.action,
                targetHint: pick.targetHint,
                frameFound: true,
                frameClause: pick.frameClause,
        };
}

// ---------------------------------------------------------------------------
// Task continuity (v0.18): short follow-up phrases
// ---------------------------------------------------------------------------

// A follow-up carries NO new instructions — it points back at the previous
// task ("继续", "还是不对"). Matched against the WHOLE message (trailing
// punctuation stripped); anything with its own verbs/clauses must go
// through full classification. Tails are capped at 4 separator-free chars
// so "继续，只分析" (carries an instruction) never matches.
const FOLLOWUP_PATTERNS = [
        /^(?:继续|接着)[^，。,;；]{0,4}$/,
        /^再(?:看看|试试|检查一下|跑一下|来一次|来一遍)$/,
        /^还是(?:不对|不行|没好|没修好|没解决|有报错|报错|失败|出错)$/,
        /^没(?:修好|解决|生效|好|弄好)$/,
        /^(?:刚才|前面|上面)(?:那个|这个|说的)?(?:问题|地方|报错|bug|文件|函数)?(?:呢|吧)?$/,
        /^(?:那个|这个)(?:问题|地方|报错|bug)(?:呢|吧)?$/,
        /^按(?:这个|计划|方案)(?:做|来|执行|改)$/,
        /^就按(?:这个|计划|方案)(?:来|做|执行)?$/,
        /^还(?:差一点|没完成|没弄完|有问题)$/,
];

/**
 * True when the whole prompt is a bare continuation of the previous task
 * (no new imperative frame of its own). Caller inherits task/domains from
 * the last decision and recomputes intent + risk escalation.
 */
export function isFollowUpPrompt(prompt) {
        return classifyFollowUp(prompt).type !== "none";
}

// Action follow-ups convert advice into execution ("按这个做" after a
// read-only analysis must become mutate, not inherit read-only).
const FOLLOWUP_EXECUTE_RE =
        /^(?:按(?:这个|计划|方案|刚才的?)(?:做|来|执行|改|实施)|就按(?:这个|计划|方案)(?:来|做|执行|实施)?|照(?:这个|计划|方案)(?:做|来|执行)|继续(?:修|改|执行|部署|删|加|创建|写|实施|落地)|去(?:改|修|执行|做)吧?|动手吧|开工吧|直接做|do it|apply it|go ahead|make the change|apply the plan)$/;

// Inspection follow-ups keep looking without asserting mutation.
const FOLLOWUP_INSPECT_RE =
        /^(?:再(?:看看|试试|检查一下|跑一下|看一遍|查一遍)|look again|check again|try again)$/;

/**
 * Classify a whole-message follow-up (v0.20):
 *   "execute" — converts previous advice into execution → intent mutate
 *   "inspect" — keep looking; no intent assertion
 *   "neutral" — plain continuation; inherit previous intent
 *   "none"    — not a follow-up; full classification applies
 */
export function classifyFollowUp(prompt) {
        const t = String(prompt ?? "")
                .replace(/[。.!！？?\s]+$/u, "")
                .trim();
        if (!t || t.length > 20) return { type: "none" };
        if (FOLLOWUP_EXECUTE_RE.test(t)) return { type: "execute" };
        if (FOLLOWUP_INSPECT_RE.test(t)) return { type: "inspect" };
        if (FOLLOWUP_PATTERNS.some((re) => re.test(t)))
                return { type: "neutral" };
        return { type: "none" };
}
