// Deterministic task/domain classifier.
//
// v0.13 design goals (post noise-audit):
//   - Domains load on STRONG evidence, not on any single keyword hit.
//     A bare "组件" must not drag in the whole frontend policy; it needs a
//     co-occurring frame term ("React", "Vue") or a second weak hit.
//   - Confidence reflects CANDIDATE DISPERSION, not just the top score.
//     Three task types scoring 7/6/6 is not 95% confident — it's a coin toss.
//   - Domain count is capped (default 2). 宁可少而准，不要把模型重新淹没在
//     Policy 里 — the whole point of this extension is to reduce context
//     noise for drift-prone models; the classifier must not manufacture it.
//
// routing.json domainRules supports two formats:
//   legacy:  { "database": ["postgres", "sql", ...] }
//            → every term is STRONG (any match triggers). Preserves the old
//              behavior byte-for-byte for user-authored configs.
//   current: { "database": { "strong": [...], "weak": [...] } }
//            → strong match triggers immediately;
//              weak matches only trigger when their combined weight
//              reaches TRIGGER_SCORE (i.e. 2+ distinct weak terms).

const STRONG_SCORE = 2;
const WEAK_SCORE = 0.5;
const TRIGGER_SCORE = 1.0;

function normalize(text) {
  return String(text ?? "").trim().toLowerCase();
}

function includesAny(text, terms = []) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

function matchedTerms(text, terms = []) {
  return terms.filter((term) => text.includes(String(term).toLowerCase()));
}

/** Accept both legacy array rules and the current {strong, weak} shape. */
function parseDomainRule(rule) {
  if (Array.isArray(rule)) return { strong: rule, weak: [] };
  return { strong: rule?.strong ?? [], weak: rule?.weak ?? [] };
}

/**
 * Score one domain against the prompt.
 * Returns null when not triggered, else { score, evidence[] } where
 * evidence explains exactly why (strong hits / accumulated weak hits).
 */
function scoreDomain(text, rule) {
  const { strong, weak } = parseDomainRule(rule);
  const strongHits = matchedTerms(text, strong);
  if (strongHits.length > 0) {
    return {
      score: strongHits.length * STRONG_SCORE,
      evidence: [`strong: ${strongHits.slice(0, 3).join(", ")}`],
    };
  }
  const weakHits = matchedTerms(text, weak);
  if (weakHits.length === 0) return null;
  const score = weakHits.length * WEAK_SCORE;
  if (score < TRIGGER_SCORE) {
    return {
      score,
      triggered: false,
      evidence: [
        `weak-only: ${weakHits.slice(0, 3).join(", ")} (score ${score} < ${TRIGGER_SCORE}, needs a frame term or a second signal)`,
      ],
    };
  }
  return {
    score,
    evidence: [`weak×${weakHits.length}: ${weakHits.slice(0, 3).join(", ")}`],
  };
}

export function classifyTask(prompt, routing, domainHints = [], options = {}) {
  const maxDomains = Math.max(1, Number(options.maxDomains ?? 2));
  const text = normalize(prompt);
  const reasons = [];
  const scores = {
    documentation: 0,
    debugging: 0,
    review: 0,
    research: 0,
    architecture: 0,
    coding: 1,
  };

  for (const [task, terms] of Object.entries(routing.taskRules ?? {})) {
    const matches = matchedTerms(text, terms);
    if (matches.length > 0) {
      scores[task] = (scores[task] ?? 0) + matches.length * 2;
      reasons.push(`task:${task} matched ${matches.slice(0, 3).join(", ")}`);
    }
  }

  // Prefer debugging over documentation when the user is fixing broken docs tooling,
  // and prefer architecture when explicit design/migration language is present.
  if (scores.architecture > 1) scores.architecture += 2;
  if (scores.debugging > 1) scores.debugging += 1;

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
  triggered.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));

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
  const analysisOnly = includesAny(text, routing.analysisOnlyHints ?? []);

  let risk = "medium";
  if (highMatches.length > 0) {
    risk = "high";
    reasons.push(`risk:high matched ${highMatches.slice(0, 3).join(", ")}`);
  } else if (taskType === "architecture") {
    risk = "high";
    reasons.push("risk:high because architecture/design migration work is broad by default");
  } else if (mediumMatches.length > 0) {
    risk = "medium";
    reasons.push(`risk:medium matched ${mediumMatches.slice(0, 3).join(", ")}`);
  } else if (["documentation", "review", "research"].includes(taskType)) {
    risk = "low";
    reasons.push(`risk:low for ${taskType} task`);
  } else if (simpleMatches.length > 0 && text.length < 500) {
    risk = "low";
    reasons.push(`risk:low matched simple hint ${simpleMatches.slice(0, 2).join(", ")}`);
  }

  if (analysisOnly && risk === "high") {
    reasons.push("analysis-only request detected; mutation is not requested");
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
  // Quadratic curve: a runaway winner pays ~nothing, a near-tie pays the
  // full 0.35. Penalties under 0.05 aren't worth surfacing in reasons.
  const dispersionPenalty = Math.round(Math.pow(1 - dominance, 2) * 35) / 100;
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
    analysisOnly,
    reasons,
  };
}
