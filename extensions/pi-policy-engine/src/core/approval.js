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

// v0.22 sequential resolution: the response is split into clauses and
// resolved IN ORDER — "cancel the plan—actually, go ahead" must approve,
// "算了，还是按原计划执行" must approve, while "批准，但先别动数据库，
// 其他按计划执行" must STAY revise (a constraint sticks; later generic
// approval does not un-stick it — only a correction does).
//
// Whole-CLAUSE cancellation, anchored: "先别动数据库" (a scoped constraint
// on part of the plan) must never cancel the whole plan — the v0.21
// unanchored CANCEL_RE turned every scoped rejection into a full cancel.
const CANCEL_WHOLE_RE =
  /^(?:先别做了?|先停下来|不做了|算了|放弃(?:这个计划|方案|吧)?|取消(?:这个|整个|该)?(?:计划|方案|任务|吧)?|不批准|不通过|不同意(?:此方案)?|不要动|先别动|别执行|不要执行|先不执行|reject the (?:whole )?plan|cancel (?:this |the )?(?:whole )?plan|drop (?:this |the )?plan|not approved|do not execute|don'?t execute|never mind|stop (?:the plan|everything))$/i;

// Correction heads (v0.22): strip the prefix and RESET the resolution —
// the remainder is the user's latest instruction.
const APPROVAL_CORRECTION_HEAD_RE =
  /^(不对|不对了|等等|等一下|改主意|改为|改成|换成|其实|实际上|重新说|说错了|说反了|换个思路|还是|算了说|wrong|actually|instead|wait|scratch that|on second thought|never mind.*|hold on)\s*/i;

// Scoped rejection (v0.22 P1): a negated action WITH a target revokes part
// of the plan, not all of it — "不要执行第二步" / "hold off on database
// changes" are constraints (revise), not cancellations.
const SCOPED_REJECT_RE =
  /(不要|先别|别|不准)\s*[^，。；！？]{0,6}(执行|做|动|改|碰|touch|do|change|execute|modify)[^，。；！？]{0,12}\S|\bhold off on\b/i;

// Constraint on a target: 不要改数据库 / 别动配置 / don't touch the schema.
const NEGATED_TARGET_RE =
  /(不要|别|不准|禁止|don't|do not)\s*[^，。；！？]{0,8}(改|动|碰|修|删|改掉|touch|modify|delete|remove|alter)/i;

// Contrast = scope adjustment: "不过只先做第一步" / "but fix the typo first".
const CONTRAST_RE =
  /(但是|不过|但|然而|可是|除了|除非|\bbut\b|however|except\b|unless\b)/i;

// Added instructions riding on an approval: "别忘了跑测试" / "执行时保持
// API 兼容" / "先备份数据库" — new obligations, so the plan is revised.
const INSTRUCTION_RE =
  /(别忘了|记得|确保|注意|保持|先备份|备份|再跑|先跑|跑一遍|顺便|make sure|remember to|keep the|backup|also run)/i;

// The approval grammar: phrases that may appear in a PURE approval.
// Longest-first stripping; Latin phrases are stripped with word boundaries
// so "go" never eats into "google".
const APPROVAL_PHRASES = [
  // ZH — long forms first
  "按原计划执行",
  "按原计划做",
  "按原计划来",
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
  /^(?:吧|呢|啊|哈|嗯|哦|呀|哟|诶|了|的|地|得|先|就|并|直接|立即|马上|现在|把|被|给|这个|那个|那个|其他|其余|一下|来|去|做|干|动|上)+$/;
const EN_FILLER_RE =
  /^(?:it|now|then|please|just|go|ahead|on|to|do|the|this|that|with|and|or|a|an|is|are|be|for|you|me|we|i|my|our|us|will|can|may|should|shall|ok|okay|fine|good|yes|yeah|yep|now|there|here|rest|others|remaining|other)+$/i;

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
 * Classify one clause of a plan response:
 * "approve" | "revise" | "cancel" | "discuss" | null (no signal).
 */
function classifyApprovalClause(clause) {
  if (PLAN_CHANGE_RE.test(clause)) return "revise";
  if (NEGATED_TARGET_RE.test(clause) || SCOPED_REJECT_RE.test(clause)) {
    return "revise";
  }
  if (CONTRAST_RE.test(clause)) return "revise";
  if (INSTRUCTION_RE.test(clause)) return "revise";
  // Questions never release — "可以执行吗" asks, it does not approve.
  if (QUESTION_RE.test(clause)) return "discuss";
  const { rest, found } = stripApprovals(clause);
  if (!found) return null;
  if (isFillerOnly(rest)) return "approve";
  const core = rest.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (CONTINUATION_RE.test(core)) return "approve";
  // Approval flavor + leftover content = a new constraint attached.
  return "revise";
}

/**
 * Classify a user response while a strict plan is awaiting approval.
 *
 * v0.22: sequential clause resolution — the user's LAST effective
 * instruction wins; constraints (revise) STICK until a correction head
 * resets them; a whole-clause cancel only fires when the clause is
 * nothing but cancellation.
 *
 * @param {string} prompt Raw user prompt.
 * @returns {"approve"|"revise"|"discuss"|"cancel"|"unknown"}
 */
export function classifyPlanResponse(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text) return "unknown";

  const clauses = text
    .split(/[，。；、！？!?,;\n\r—–]+/)
    .map((c) => c.trim())
    .filter(Boolean);

  let verdict = null;
  let stickyRevise = false;
  for (let clause of clauses) {
    if (CANCEL_WHOLE_RE.test(clause)) {
      verdict = "cancel";
      stickyRevise = false;
      continue;
    }
    const stripped = clause.replace(APPROVAL_CORRECTION_HEAD_RE, "").trim();
    if (stripped.length < clause.length) {
      // Correction resets everything; its remainder is the new instruction.
      verdict = null;
      stickyRevise = false;
      if (!stripped) continue;
      clause = stripped;
    }
    const v = classifyApprovalClause(clause);
    if (v === "cancel") {
      verdict = "cancel";
      stickyRevise = false;
    } else if (v === "revise") {
      verdict = "revise";
      stickyRevise = true; // constraints stick; later approve ≠ un-stick
    } else if (v === "approve") {
      if (!stickyRevise && verdict !== "cancel") verdict = "approve";
    } else if (v === "discuss") {
      if (verdict === null && !stickyRevise) verdict = "discuss";
    }
  }
  if (verdict) return verdict;
  if (stickyRevise) return "revise";

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
