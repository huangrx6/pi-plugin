// Semantic signal matcher for routing rules.
//
// v0.13's substring matcher (text.includes(term)) had a nesting bug family:
//   "reproduction" contains "production" contains "prod"
//   "debug"        contains "bug"
//   "架构设计"      matched both "架构设计" and "架构" (double-counted)
// This module replaces it with three rules:
//
//   EN + CJK-safe word boundary: a term matches only if the character
//     before and after the match are NOT word characters (letters, digits,
//     underscore, or CJK). CJK counts as a word char so that "架构" does not
//     match inside "架构设计" — longest-match-first resolves that instead.
//
//   Longest-match-wins: when several terms match at overlapping positions,
//     only the longest one is kept (架构设计 beats 架构; reproduction beats
//     production beats prod).
//
//   Signal-group dedup: terms can be declared as aliases of one concept
//     ("api" / "接口" / "endpoint"). Matching two aliases of the same group
//     counts as ONE signal, while matching two different groups ("api" +
//     "spring") counts as two independent pieces of evidence.

/**
 * Is this char part of a "word" for boundary purposes?
 * Letters, digits, underscore, and any CJK ideograph / kana / hangul.
 */
function isWordChar(ch) {
 if (!ch) return false;
 return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Does this term contain CJK characters? CJK text has no whitespace word
 * separation (架构设计方案 = 架构+设计+方案), so boundary checks don't apply:
 * nested Chinese terms are resolved by longest-match-wins instead.
 */
function hasCJK(s) {
 return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
}

/**
 * Find non-overlapping, longest-match-first occurrences of every term.
 * Returns: Map<term, count> with nesting resolved — a longer term consumes
 * its match range so shorter/nested terms inside it are not counted.
 *
 * Boundary rules:
 *   - Latin/digit terms require non-word chars around the match
 *     ("classic" must not match "ass").
 *   - CJK-containing terms skip boundary checks (no spaces in Chinese);
 *     nesting like 架构 ⊂ 架构设计 is handled by longest-match-wins.
 *
 * Example: text "架构设计", terms ["架构", "架构设计"]
 *   → { "架构设计": 1 }   (架构 swallowed by the longer match)
 * Example: text "reproduction steps", terms ["prod", "production"]
 *   → { "production": 1 } (prod swallowed)
 */
export function matchTerms(text, terms) {
 const t = String(text ?? "");
 const candidates = [];
 for (const raw of terms) {
  const term = String(raw ?? "").toLowerCase();
  if (!term) continue;
  const needsBoundary = !hasCJK(term);
  let from = 0;
  while (from <= t.length) {
   const idx = t.indexOf(term, from);
   if (idx === -1) break;
   const end = idx + term.length;
   if (needsBoundary) {
    const before = idx > 0 ? t[idx - 1] : "";
    const after = t[end] ?? "";
    if (isWordChar(before) || isWordChar(after)) {
     from = idx + 1;
     continue;
    }
   }
   candidates.push({ term, idx, end });
   from = idx + 1;
  }
 }
 // Longest first; ties broken by earlier position.
 candidates.sort((a, b) => b.term.length - a.term.length || a.idx - b.idx);
 const taken = [];
 const counts = new Map();
 for (const c of candidates) {
  if (taken.some((r) => c.idx < r.end && c.end > r.idx)) continue; // overlap
  taken.push(c);
  counts.set(c.term, (counts.get(c.term) ?? 0) + 1);
 }
 return counts;
}

/**
 * Positional variant of matchTerms: returns the accepted hits as
 * [{ term, idx, end }] so callers can reason about what surrounds a
 * match (e.g. negation scope in intent.js). Same matching rules:
 * longest-match-wins, Latin boundary check, CJK free.
 */
export function findTerms(text, terms) {
 const t = String(text ?? "");
 const candidates = [];
 for (const raw of terms) {
  const term = String(raw ?? "").toLowerCase();
  if (!term) continue;
  const needsBoundary = !hasCJK(term);
  let from = 0;
  while (from <= t.length) {
   const idx = t.indexOf(term, from);
   if (idx === -1) break;
   const end = idx + term.length;
   if (needsBoundary) {
    const before = idx > 0 ? t[idx - 1] : "";
    const after = t[end] ?? "";
    if (isWordChar(before) || isWordChar(after)) {
     from = idx + 1;
     continue;
    }
   }
   candidates.push({ term, idx, end });
   from = idx + 1;
  }
 }
 candidates.sort((a, b) => b.term.length - a.term.length || a.idx - b.idx);
 const taken = [];
 for (const c of candidates) {
  if (taken.some((r) => c.idx < r.end && c.end > r.idx)) continue;
  taken.push(c);
 }
 return taken.sort((a, b) => a.idx - b.idx);
}

/**
 * Expand flat term lists into signal groups.
 * Two shapes supported:
 *   ["api", "接口", "spring"]            → each term is its own group
 *   [{ group: "api", terms: [...] }, …]  → explicit grouping (aliases dedupe)
 */
export function toSignalGroups(termsOrGroups) {
 if (!Array.isArray(termsOrGroups)) return [];
 return termsOrGroups.map((entry, i) => {
  if (typeof entry === "string") {
   return { id: entry, terms: [entry] };
  }
  const terms = (entry?.terms ?? []).map(String);
  return { id: entry?.group ?? `signal-${i}`, terms };
 });
}

/**
 * Match a list of signal groups against text.
 * Returns { hits, score } where:
 *   hits   = array of { id, term } — one per MATCHED GROUP (aliases deduped)
 *   score  = number of distinct matched groups (the evidence unit)
 *
 * "api"(接口 alias) + "spring controller"(framework) → 2 hits.
 * "api" + "接口" alone                                → 1 hit (same group).
 */
export function matchSignalGroups(text, groups) {
 const allTerms = [];
 for (const g of groups) for (const term of g.terms) allTerms.push(term);
 const counts = matchTerms(text, allTerms);

 const hits = [];
 const seen = new Set();
 for (const g of groups) {
  for (const term of g.terms) {
   if ((counts.get(term) ?? 0) > 0 && !seen.has(g.id)) {
    seen.add(g.id);
    // Record which concrete term fired, for explainability.
    const fired = g.terms.find((t) => (counts.get(t) ?? 0) > 0);
    hits.push({ id: g.id, term: fired ?? term });
    break;
   }
  }
 }
 return { hits, score: hits.length };
}

/**
 * Convenience: score a flat keyword list with the new matcher.
 * Drop-in replacement for old matchedTerms() call sites that need
 * boundary + longest-match semantics but have no signal grouping yet.
 * Returns array of matched terms (longest-match-wins, deduped).
 */
export function matchedTerms(text, terms) {
 const counts = matchTerms(text, terms);
 const out = [];
 for (const [term] of counts) out.push(term);
 return out;
}
