/**
 * Retrieval metrics over a ranked list of FILE paths.
 *
 * Gold = the source files the merged PR actually changed. A retriever is judged
 * only on whether it surfaced those files, never on prose. No judge model, no
 * similarity score — which is the entire point: the numbers are reproducible by
 * anyone with the same git history.
 */

/** Fraction of gold files present in the top-k of `ranked`. */
export function recallAt(ranked, gold, k) {
  if (gold.length === 0) return null;
  const top = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const g of gold) if (top.has(g)) hit++;
  return hit / gold.length;
}

/** 1 / rank of the first gold file (0 when none found). */
export function mrr(ranked, gold) {
  const g = new Set(gold);
  for (let i = 0; i < ranked.length; i++) if (g.has(ranked[i])) return 1 / (i + 1);
  return 0;
}

/** Did any gold file appear at all in the returned list? */
export function anyHit(ranked, gold) {
  const g = new Set(gold);
  return ranked.some((r) => g.has(r));
}

/**
 * Recall under a fixed token budget.
 *
 * This is the honest comparison. A retriever that dumps 200 files has great
 * recall@200 and zero practical value, because the agent has to pay for the
 * whole pack. So we walk the ranked list accumulating each entry's rendered
 * token cost, stop at the budget, and score only what fits.
 *
 * @param {Array<{path:string, tokens:number}>} entries ranked, with per-entry cost
 */
export function recallUnderBudget(entries, gold, budgetTokens) {
  if (gold.length === 0) return null;
  const g = new Set(gold);
  let spent = 0;
  let hit = 0;
  const seen = new Set();
  for (const e of entries) {
    if (spent + e.tokens > budgetTokens) break;
    spent += e.tokens;
    if (g.has(e.path) && !seen.has(e.path)) { hit++; seen.add(e.path); }
  }
  return { recall: hit / gold.length, tokensSpent: spent };
}

export function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Wilson 95% interval — small-n honesty for the rate-style metrics. */
export function wilson95(successes, n) {
  if (!n) return [null, null];
  const z = 1.96;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
