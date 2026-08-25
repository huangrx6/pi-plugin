// Deterministic task/domain classifier.
//
// v0.16 design (Intent beats mention, fully wired):
//   - Task scoring runs through signal groups (matcher.js): word forms
//     (debug/debugging/debugged) and translations (api/接口/endpoint) are
//     aliases of ONE signal; distinct groups are independent evidence.
//   - The intent frame (intent.js::extractIntentFrame) locates the clause
//     the user is actually ACTING in. Groups matched inside the frame
//     count double; groups matched elsewhere count as mention evidence
//     (half weight). The task the frame anchors gets a +2 bonus.
//       "README 里记录了架构拆分失败的原因，现在帮我把这段文档改准确"
//     → documentation (frame: 修改+文档), not architecture (background).
//   - Domains load on STRONG evidence (one strong group) or 2+ distinct
//     weak groups; same-group aliases never stack ("api"+"接口" = 1 weak).
//   - Confidence reflects CANDIDATE DISPERSION, not just the top score.
//   - Domain count is capped (default 2). 宁可少而准，不要把模型重新淹没在
//     Policy 里 — the whole point of this extension is to reduce context
//     noise for drift-prone models; the classifier must not manufacture it.
//
// routing.json taskRules/domainRules support two formats (matcher.js::
// toSignalGroups): flat string arrays (legacy — each term its own group)
// and { "group": "...", "terms": [...] } alias groups (current).

const IN_FRAME_SCORE = 2;
const MENTION_SCORE = 1;
const FRAME_ANCHOR_BONUS = 2;
const STRONG_SCORE = 2;
const WEAK_SCORE = 0.5;
const TRIGGER_SCORE = 1.0;

import { matchSignalGroups, matchedTerms, toSignalGroups } from "./matcher.js";
import { extractExecutionIntent, extractIntentFrame } from "./intent.js";

function normalize(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase();
}

/** Accept both legacy array rules and the current {strong, weak} shape. */
function parseDomainRule(rule) {
  if (Array.isArray(rule)) return { strong: rule, weak: [] };
  return { strong: rule?.strong ?? [], weak: rule?.weak ?? [] };
}

/**
 * Score one domain against the prompt using signal groups.
 * Returns null when not triggered, else { score, evidence[] } where
 * evidence explains exactly why (strong groups / accumulated weak groups).
 */
function scoreDomain(text, rule) {
  const { strong, weak } = parseDomainRule(rule);
  const strongHit = matchSignalGroups(text, toSignalGroups(strong));
  if (strongHit.score > 0) {
    return {
      score: strongHit.score * STRONG_SCORE,
      evidence: [
        `strong: ${strongHit.hits
          .map((h) => h.id)
          .slice(0, 3)
          .join(", ")}`,
      ],
    };
  }
  const weakHit = matchSignalGroups(text, toSignalGroups(weak));
  if (weakHit.score === 0) return null;
  const score = weakHit.score * WEAK_SCORE;
  if (score < TRIGGER_SCORE) {
    return {
      score,
      triggered: false,
      evidence: [
        `weak-only: ${weakHit.hits
          .map((h) => h.id)
          .slice(0, 3)
          .join(
            ", ",
          )} (score ${score} < ${TRIGGER_SCORE}; same-group aliases never stack, needs a second distinct group)`,
      ],
    };
  }
  return {
    score,
    evidence: [
      `weak×${weakHit.score}: ${weakHit.hits
        .map((h) => h.id)
        .slice(0, 3)
        .join(", ")}`,
    ],
  };
}

/**
 * Score one task's signal groups with intent-frame weighting.
 * Returns { score, ids, frameIds } — frameIds are the groups matched
 * inside the imperative clause (intent), the rest are mention evidence.
 */
function scoreTask(text, terms, frame) {
  const groups = toSignalGroups(terms);
  const all = matchSignalGroups(text, groups);
  if (all.score === 0) return { score: 0, ids: [], frameIds: [] };
  const frameIds = frame.frameFound
    ? new Set(
        matchSignalGroups(frame.frameClause, groups).hits.map((h) => h.id),
      )
    : new Set();
  let score = 0;
  for (const hit of all.hits) {
    score += frameIds.has(hit.id) ? IN_FRAME_SCORE : MENTION_SCORE;
  }
  if (frameIds.size > 0) score += FRAME_ANCHOR_BONUS;
  return {
    score,
    ids: all.hits.map((h) => h.id),
    frameIds: [...frameIds],
  };
}

export function classifyTask(prompt, routing, domainHints = [], options = {}) {
  const maxDomains = Math.max(1, Number(options.maxDomains ?? 2));
  const text = normalize(prompt);
  const reasons = [];
  const frame = extractIntentFrame(prompt);
  if (frame.frameFound) {
    reasons.push(`frame:${frame.action} "${frame.frameClause.slice(0, 30)}"`);
  }
  const scores = {
    documentation: 0,
    debugging: 0,
    review: 0,
    research: 0,
    architecture: 0,
    // Base 0.5, not 1: coding is the DEFAULT guess when nothing matched.
    // A single real task-group hit (score 1) must beat it honestly instead
    // of relying on tie-break order.
    coding: 0.5,
  };

  for (const [task, terms] of Object.entries(routing.taskRules ?? {})) {
    const { score, ids, frameIds } = scoreTask(text, terms, frame);
    if (score > 0) {
      scores[task] = (scores[task] ?? 0) + score;
      reasons.push(
        `task:${task} matched ${ids.join(", ")}${frameIds.length > 0 ? ` (frame: ${frameIds.join(", ")})` : ""}`,
      );
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const taskType = ranked[0][0];
  const topScore = ranked[0][1];
  const runnerUpScore = ranked[1]?.[1] ?? 0;

  // ---- domains: score → threshold → rank → cap --------------------------

  const hints = new Set(domainHints ?? []);
  const triggered = []; // { domain, score, evidence }

  for (const [domain, rule] of Object.entries(routing.domainRules ?? {})) {
    if (hints.has(domain)) continue; // explicit hints bypass scoring
    const result = scoreDomain(text, rule);
    if (!result) continue;
    if (result.triggered === false) {
      reasons.push(`domain:${domain} dropped (${result.evidence[0]})`);
      continue;
    }
    triggered.push({ domain, score: result.score, evidence: result.evidence });
  }
  triggered.sort(
    (a, b) => b.score - a.score || a.domain.localeCompare(b.domain),
  );

  const domains = new Set(hints);
  for (const t of triggered) {
    if (domains.size >= maxDomains) {
      reasons.push(
        `domain:${t.domain} dropped (capped at ${maxDomains}; weaker than ${[...domains].join(", ")})`,
      );
      continue;
    }
    domains.add(t.domain);
    reasons.push(`domain:${t.domain} loaded (${t.evidence[0]})`);
  }
  if (taskType === "documentation" && !domains.has("documentation")) {
    // documentation tasks always get their (tiny) domain policy.
    if (domains.size >= maxDomains && !hints.has("documentation")) {
      reasons.push("domain:documentation dropped (capped)");
    } else {
      domains.add("documentation");
    }
  }

  // ---- risk --------------------------------------------------------------

  const highMatches = matchedTerms(text, routing.highRisk ?? []);
  const mediumMatches = matchedTerms(text, routing.mediumRisk ?? []);
  const simpleMatches = matchedTerms(text, routing.simpleHints ?? []);
  const executionIntent = extractExecutionIntent(prompt);

  let risk = "medium";
  if (highMatches.length > 0) {
    risk = "high";
    reasons.push(`risk:high matched ${highMatches.slice(0, 3).join(", ")}`);
  } else if (taskType === "architecture") {
    risk = "high";
    reasons.push(
      "risk:high because architecture/design migration work is broad by default",
    );
  } else if (mediumMatches.length > 0) {
    risk = "medium";
    reasons.push(`risk:medium matched ${mediumMatches.slice(0, 3).join(", ")}`);
  } else if (["documentation", "review", "research"].includes(taskType)) {
    risk = "low";
    reasons.push(`risk:low for ${taskType} task`);
  } else if (simpleMatches.length > 0 && text.length < 500) {
    risk = "low";
    reasons.push(
      `risk:low matched simple hint ${simpleMatches.slice(0, 2).join(", ")}`,
    );
  }

  if (executionIntent === "read-only" && risk === "high") {
    reasons.push("read-only intent detected; mutation is not requested");
  }

  // ---- confidence: base from top score, penalized by candidate dispersion
  //
  // A 7/6/6 split across three task types is NOT 95% — it's nearly a tie.
  // dominance = (top - runnerUp) / top ∈ [0, 1]; near-ties push confidence
  // toward the floor so /policy preview shows an honest number and users
  // know to reach for `/policy once ...`.

  let confidence;
  if (topScore >= 5) confidence = 0.95;
  else if (topScore >= 3) confidence = 0.85;
  else if (topScore >= 2) confidence = 0.75;
  else confidence = 0.65;
  const dominance = topScore > 0 ? (topScore - runnerUpScore) / topScore : 0;
  // Quadratic curve (v0.16 ×50): a runaway winner pays ~nothing, a 6-vs-4
  // split pays ~0.22, a near-tie pays the full 0.5 to the 0.35 floor.
  // Penalties under 0.05 aren't worth surfacing in reasons.
  const dispersionPenalty = Math.round((1 - dominance) ** 2 * 50) / 100;
  if (dispersionPenalty >= 0.05) {
    confidence = Math.max(0.35, confidence - dispersionPenalty);
    reasons.push(
      `confidence penalized: candidates dispersed (top=${topScore}, runner-up=${runnerUpScore}, dominance=${dominance.toFixed(2)})`,
    );
  }

  return {
    taskType,
    runnerUpTask: ranked[1]?.[0],
    domains: [...domains],
    risk,
    confidence,
    executionIntent,
    reasons,
  };
}
