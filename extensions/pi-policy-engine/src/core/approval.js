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

// Autonomy grants (v0.24): the user explicitly hands over the approval
// decision — "不用征求我的意见了" / "don't ask me" / "自己决定". This is a
// DIFFERENT thing from a plain approval: it releases the gate AND
// authorizes continued execution without further stops.
//
// Verified live failure (2026-09-03, the exact message that motivated
// v0.24): "所有的内容你自动进行评估，不用询问我，你自己给出具体的实施
// 方案…构思完就执行，不用征求我的意见了" was classified REVISE because
// (a) "构思完就执行" contains the approval phrase 执行 with substantive
// leftover (approval flavor + content = revise), and (b) 询问/意见 were
// not approval vocabulary anywhere, so nothing lifted the gate. The user
// went to bed with the agent still stuck presenting plans for approval.
//
// Precision rules: negator + ask-object forms REQUIRE the object
// (意见/同意/批准/我) so "别问问题" never matches; "不用问" requires 了 or
// 我. Kept deliberately narrow — a false release is worse than a missed
// one (the user can always approve explicitly).
export const AUTONOMY_GRANT_RE = new RegExp(
  [
    "不用征求(?:我的)?(?:意见|同意|批准)",
    "(?:不用|无需|无须|不需要)(?:再)?(?:询问|请示|问)(?:我)?(?:了)?",
    "(?:不用|无需|不需要)我?(?:确认|批准|点头|审批)",
    "别问我(?:了)?",
    "自己(?:决定|拿主意|判断|评估后执行)",
    "自主(?:决定|执行|判断|完成)",
    "全权(?:处理|负责|决定)",
    "(?:不用|不要|别)(?:再)?(?:停下来|停下来等我|停)",
    "不(?:希望|用|要)(?:你)?(?:停下来|中断|停下来问|打断)",
    "don'?t ask me",
    "without asking",
    "no need to ask",
    "don'?t (?:stop|wait for my|interrupt)",
    "keep going",
    "act autonomously",
    "you decide",
    "carry on",
  ].join("|"),
  "i",
);

// Constraint markers reused by the lifecycle to decide whether an
// APPROVE-shaped response still needs evidence merging (v0.24).
export const APPROVAL_CONSTRAINT_RES = [
  NEGATED_TARGET_RE,
  SCOPED_REJECT_RE,
  INSTRUCTION_RE,
];

/**
 * Classify one clause of a plan response:
 *   "approve"     approval flavor + filler only
 *   "revise"      constraint / instruction / contrast / plan change
 *   "discuss"     question
 *   "filler"      bare filler/continuation, no signal
 *   "substantive" real content with no approval flavor ("我还有一个要求")
 * The resolver turns approve+substantive into revise and approve+question
 * into discuss — only a PURE approval releases (v0.23 P0: enumerated
 * constraints alone let "批准，不要重构" / "批准，我还有一个要求" /
 * "批准，为什么…" all leak through as approve).
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
  const core = rest.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (isFillerOnly(rest)) return found ? "approve" : "filler";
  if (CONTINUATION_RE.test(core)) return found ? "approve" : "filler";
  if (found) return "revise"; // approval flavor + leftover content
  return "substantive"; // real content, no approval flavor
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
  // v0.24: an autonomy grant releases the gate for the REST of the
  // message. Constraints that ride along ("…不用征求我的意见了，但别动数
  // 据库") become execution constraints — they must NOT re-lock the gate
  // the user just handed over. Only a whole-clause cancel or a correction
  // head (不对/等等…) revokes the release.
  let released = false;
  for (let clause of clauses) {
    if (CANCEL_WHOLE_RE.test(clause)) {
      verdict = "cancel";
      stickyRevise = false;
      released = false;
      continue;
    }
    const stripped = clause.replace(APPROVAL_CORRECTION_HEAD_RE, "").trim();
    if (stripped.length < clause.length) {
      // Correction resets everything; its remainder is the new instruction.
      verdict = null;
      stickyRevise = false;
      released = false;
      if (!stripped) continue;
      clause = stripped;
    }
    if (AUTONOMY_GRANT_RE.test(clause)) {
      verdict = "approve";
      stickyRevise = false;
      released = true;
      continue;
    }
    const v = classifyApprovalClause(clause);
    if (v === "cancel") {
      verdict = "cancel";
      stickyRevise = false;
      released = false;
    } else if (v === "revise") {
      if (released) continue; // constraint on released execution — noted, gate stays open
      verdict = "revise";
      stickyRevise = true; // constraints stick; later approve ≠ un-stick
    } else if (v === "discuss") {
      // A question after approval DOWNGRADES the release: "批准，为什么
      // 第二步要改数据库？" is a discussion, not an approval.
      // After an autonomy grant the release stands (the user already
      // authorized execution; a mid-flight question is not a retraction).
      if (!stickyRevise && !released && verdict !== "cancel")
        verdict = "discuss";
    } else if (v === "approve") {
      if (
        !stickyRevise &&
        !released &&
        verdict !== "cancel" &&
        verdict !== "discuss"
      ) {
        verdict = "approve";
      }
    } else if (v === "substantive") {
      // v0.23 P0 — conservative default: anything substantive attached to
      // an approval is a revision of it ("批准，我还有一个要求" / "批准，
      // 不要重构" / "批准，顺序别变"). Only filler/continuation keeps a
      // release pure.
      if (verdict === "approve" && !released) {
        verdict = "revise";
        stickyRevise = true;
      }
      // bare substantive without any approval keeps awaiting (unknown).
    }
    // "filler": no signal, ignored.
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
