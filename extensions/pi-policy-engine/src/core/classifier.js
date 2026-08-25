function normalize(text) {
  return String(text ?? "").trim().toLowerCase();
}

function includesAny(text, terms = []) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

function matchedTerms(text, terms = []) {
  return terms.filter((term) => text.includes(String(term).toLowerCase()));
}

export function classifyTask(prompt, routing, domainHints = []) {
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

  const taskType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];

  const domains = new Set(domainHints ?? []);
  for (const [domain, terms] of Object.entries(routing.domainRules ?? {})) {
    const matches = matchedTerms(text, terms);
    if (matches.length > 0) {
      domains.add(domain);
      reasons.push(`domain:${domain} matched ${matches.slice(0, 3).join(", ")}`);
    }
  }
  if (taskType === "documentation") domains.add("documentation");

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
    // High-risk topic can still be analysis-only; keep the risk label high so the
    // policy remains careful, but the workflow router may avoid mutation gating.
    reasons.push("analysis-only request detected; mutation is not requested");
  }

  let confidence = 0.65;
  const topScore = scores[taskType] ?? 0;
  if (topScore >= 5) confidence = 0.95;
  else if (topScore >= 3) confidence = 0.85;
  else if (topScore >= 2) confidence = 0.75;

  return {
    taskType,
    domains: [...domains],
    risk,
    confidence,
    analysisOnly,
    reasons,
  };
}
