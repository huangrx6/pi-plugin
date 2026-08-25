// Plan-response classifier for the strict-workflow state machine.
//
// v0.16 "Pure Approval grammar": instead of enumerating revise-flavored
// patterns (但是/不过/只/先/… — an endless game), the classifier now
// defines exactly what a PURE approval may contain, strips those phrases,
// and inspects the remainder:
//
//   cancel    whole message matches a cancellation pattern
//   approve   approval phrase(s) found AND remainder is empty/filler
//   discuss   remainder (or whole message) is a question
//   unknown   no approval phrase, only continuation/ack words ("继续")
//   revise    anything else — a NEW instruction or constraint remains
//
// Core principle (v1.0 P0-5): ONLY a pure approval releases execution.
//   "批准，但是不要改数据库"   → revise (remainder adds a constraint)
//   "批准，执行前先备份数据库" → revise (remainder adds an instruction)
//   "批准，先执行吧"          → approve (remainder is only 先/吧 filler)
//
// Verdicts and their state effect (see DESIGN §5):
//   approve → executing         revise → planning (re-approval required)
//   discuss → awaiting_approval cancel → idle
//   unknown → awaiting_approval (explicit reminder injected)

// Whole-message cancellation. Checked FIRST so "不批准" can never be
// reduced to "批准 + leftover 不" by the strip pass.
const CANCEL_RE =
  /(先别做了|先停下来|取消这个|取消计划|取消吧|不做了|算了|放弃这个计划|放弃方案|放弃吧|不批准|不通过|不同意|不要执行|先不执行|别执行|不要动|先别动|reject the plan|cancel (?:this |the )?plan|drop (?:this |the )?plan|not approved|do not execute|don't execute|hold off|never mind|stop the plan)/i;

// The approval grammar: phrases that may appear in a PURE approval.
// Longest-first stripping; Latin phrases are stripped with word boundaries
// so "go" never eats into "google".
const APPROVAL_PHRASES = [
  // ZH — long forms first
  "按这个计划执行",
  "按这个计划做",
  "按这个计划来",
  "按计划执行",
  "按计划做",
  "按计划来",
  "开始执行",
  "可以执行",
  "可以开始",
  "继续执行",
  "就这么办",
  "就这么做",
  "就这么写",
  "就这样吧",
  "就这样",
  "没问题",
  "批准",
  "同意",
  "通过",
  "执行",
  "开始吧",
  "动手吧",
  "开工吧",
  "好的",
  "好吧",
  "好嘞",
  "好",
  "行",
  "可以",
  "开始",
  // EN
  "looks good to me",
  "looks good",
  "so be it",
  "sounds good",
  "go ahead",
  "ship it",
  "approved",
  "approve",
  "approval",
  "proceed",
  "lgtm",
  "do it",
  "okay",
  "ok",
  "fine",
  "start",
  "execute",
  "go",
];

// Remainder tokens that carry no new instruction. NOTE: 继续/吗 are
// deliberately NOT filler — 继续 alone is ambiguous (unknown), 吗 makes
// the remainder a question (discuss).
const ZH_FILLER_RE =
  /^(?:吧|呢|啊|哈|嗯|哦|呀|哟|诶|了|的|地|得|先|就|并|直接|立即|马上|现在|把|被|给|这个|那个|一下|来|去|做|干|动|上)+$/;
const EN_FILLER_RE =
  /^(?:it|now|then|please|just|go|ahead|on|to|do|the|this|that|with|and|or|a|an|is|are|be|for|you|me|we|i|my|our|us|will|can|may|should|shall|ok|okay|fine|good|yes|yeah|yep|now|there|here)+$/i;

const CONTINUATION_RE =
  /^(?:继续|继续吧|接着来|接着做|再继续|我再看看|我再想想|稍等|等我确认|帮我看下|看看再说|thinking|let me think|hold on|wait|one sec|got it|noted|understood|looking)+[。.!！\s]*$/i;

// Explicit plan-change instructions count as revise even without any
// approval flavor ("修改计划，第二步不行").
const PLAN_CHANGE_RE =
  /(修改计划|调整计划|改一下计划|改计划|重新计划|换个方案|调整方案|修改方案|更新计划|第[一二三]步改成|revise the plan|change the plan|adjust the plan|rework the plan)/i;

const QUESTION_RE =
  /(为什么|怎么|如何|什么|哪些|是否|能不能|可以吗|会不会|\?|？|吗$)/i;

const LATIN_ONLY_RE = /^[a-z0-9\s'’,.!?;:-]+$/i;

/** Strip every approval phrase; returns { rest, found }. */
function stripApprovals(text) {
  let rest = text;
  let found = false;
  const sorted = [...APPROVAL_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    if (LATIN_ONLY_RE.test(phrase)) {
      const re = new RegExp(
        `\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "gi",
      );
      if (re.test(rest)) {
        found = true;
        rest = rest.replace(re, " ");
      }
    } else if (rest.includes(phrase)) {
      found = true;
      rest = rest.split(phrase).join(" ");
    }
  }
  return { rest, found };
}

/** True when the remainder carries no instruction beyond filler words. */
function isFillerOnly(rest) {
  const r = rest.trim();
  if (!r) return true;
  const tokens = r.split(/[\s，,、。.!！？?；;:~…·]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => ZH_FILLER_RE.test(t) || EN_FILLER_RE.test(t));
}

/**
 * Classify a user response while a strict plan is awaiting approval.
 *
 * @param {string} prompt Raw user prompt.
 * @returns {"approve"|"revise"|"discuss"|"cancel"|"unknown"}
 */
export function classifyPlanResponse(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text) return "unknown";

  // Cancel overrides everything — the plan is dead regardless of phrasing.
  if (CANCEL_RE.test(text)) return "cancel";

  const { rest, found } = stripApprovals(text);
  // Strip leading/trailing punctuation so "，继续" tests as "继续".
  const core = rest.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

  // A question about the plan is a discussion (or a permission ask like
  // "可以执行吗"), never a release. NOTE: tested on rest, not core —
  // core strips trailing punctuation, which would eat a bare "?".
  if (QUESTION_RE.test(rest.trim())) return "discuss";

  if (isFillerOnly(rest)) {
    // "批准，先执行吧" → remainder 先/吧 → approve.
    // Bare "……" or "嗯" with no approval flavor → unknown.
    return found ? "approve" : "unknown";
  }

  if (CONTINUATION_RE.test(core)) {
    // "批准，继续" → approve (keep going). Bare "继续" → unknown
    // (ambiguous: continue discussing? continue executing?).
    return found ? "approve" : "unknown";
  }

  // Approval flavor + leftover content → a NEW constraint was attached.
  if (found) return "revise";

  // No approval flavor: only an explicit plan-change instruction revises;
  // anything else ("帮我看看这个") stays unknown and keeps awaiting.
  if (PLAN_CHANGE_RE.test(core)) return "revise";
  return "unknown";
}
