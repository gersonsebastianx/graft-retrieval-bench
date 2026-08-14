#!/usr/bin/env node
/**
 * Aggregate every results/*.json into the cross-repo table.
 *
 *   node bench/report.mjs [--budget 400] [--k 10]
 *
 * Pools cases across repos rather than averaging per-repo means, so a repo with
 * more cases carries proportionally more weight — averaging the averages would
 * let a 37-case repo count the same as a 50-case one.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallAt, mrr, anyHit, mean, wilson95 } from './lib/metrics.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'results');
const RETRIEVERS = ['graft', 'bm25', 'gitgrep'];
const CONDITIONS = ['natural', 'stemblind'];

const pct = (x) => (x === null || x === undefined ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6));
const num = (x, d = 3) => (x === null || x === undefined ? '   —  ' : x.toFixed(d).padStart(6));

const files = readdirSync(RES).filter((f) => f.endsWith('.json') && !f.startsWith('ALL'));
const loaded = files.map((f) => JSON.parse(readFileSync(join(RES, f), 'utf8')));
if (!loaded.length) { console.error('no results yet'); process.exit(1); }

// ---- per repo ----
console.log('\n══ PER REPO ══');
for (const d of loaded.sort((a, b) => a.repo.id.localeCompare(b.repo.id))) {
  const n = d.results.length;
  console.log(`\n${d.repo.slug}  (${d.repo.lang}, ${n} cases)`);
  for (const cond of CONDITIONS) {
    const line = RETRIEVERS.map((r) => {
      const s = d.summary[cond][r];
      return `${r} R@10 ${pct(s.recall10)}`;
    }).join('  ·  ');
    console.log(`  ${cond.padEnd(10)} ${line}`);
  }
}

// ---- pooled ----
const pooled = {};
for (const cond of CONDITIONS) {
  pooled[cond] = {};
  for (const r of RETRIEVERS) {
    const rows = loaded.flatMap((d) => d.results.map((x) => x.byCondition[cond][r]));
    const hits = rows.filter((x) => x.anyHit).length;
    pooled[cond][r] = {
      n: rows.length,
      recall1: mean(rows.map((x) => x.recall1)),
      recall5: mean(rows.map((x) => x.recall5)),
      recall10: mean(rows.map((x) => x.recall10)),
      mrr: mean(rows.map((x) => x.mrr)),
      hitRate: hits / rows.length,
      hitRateCI: wilson95(hits, rows.length),
      packTokens: mean(rows.map((x) => x.packTokens)),
      budgetRecall: mean(rows.map((x) => x.budgetRecall)),
      ms: mean(rows.map((x) => x.ms)),
      errors: rows.filter((x) => x.error).length,
    };
  }
}

const N = pooled.natural.graft.n;
console.log(`\n\n══ POOLED — ${N} cases across ${loaded.length} repos ══`);
for (const cond of CONDITIONS) {
  console.log(`\n${cond === 'natural' ? 'NATURAL (realistic developer query)' : 'STEM-BLIND (filename words removed)'}`);
  console.log(`${'retriever'.padEnd(10)} ${'R@1'.padStart(6)} ${'R@5'.padStart(6)} ${'R@10'.padStart(6)} ${'MRR'.padStart(6)} ${'hit%'.padStart(6)} ${'95% CI'.padStart(14)} ${'pack'.padStart(6)} ${'ms'.padStart(6)}`);
  console.log('-'.repeat(84));
  for (const r of RETRIEVERS) {
    const s = pooled[cond][r];
    const ci = `[${(s.hitRateCI[0] * 100).toFixed(0)}–${(s.hitRateCI[1] * 100).toFixed(0)}%]`.padStart(14);
    console.log(`${r.padEnd(10)} ${pct(s.recall1)} ${pct(s.recall5)} ${pct(s.recall10)} ${num(s.mrr)} ${pct(s.hitRate)} ${ci} ${String(Math.round(s.packTokens)).padStart(6)} ${String(Math.round(s.ms)).padStart(6)}`);
  }
}

console.log('\nfilename-dependence (natural R@10 − stem-blind R@10):');
for (const r of RETRIEVERS) {
  const a = pooled.natural[r].recall10, b = pooled.stemblind[r].recall10;
  console.log(`  ${r.padEnd(10)} ${pct(a)} → ${pct(b)}   Δ ${((a - b) * 100).toFixed(1)} pts`);
}

console.log('\ncost per query, relative to the no-graph BM25 baseline:');
for (const r of RETRIEVERS) {
  const s = pooled.natural[r], base = pooled.natural.bm25;
  console.log(`  ${r.padEnd(10)} ${String(Math.round(s.packTokens)).padStart(5)} tok (${(s.packTokens / base.packTokens).toFixed(1)}×)   ${String(Math.round(s.ms)).padStart(5)} ms (${(s.ms / base.ms).toFixed(1)}×)`);
}

/**
 * Paired test on the pooled per-case R@10, graft vs bm25. Paired because both
 * retrievers see the identical case — the variance that matters is the
 * per-case difference, not the spread across cases.
 */
const diffs = loaded.flatMap((d) => d.results.map(
  (x) => x.byCondition.natural.graft.recall10 - x.byCondition.natural.bm25.recall10,
));
const md = mean(diffs);
const sd = Math.sqrt(diffs.reduce((a, x) => a + (x - md) ** 2, 0) / (diffs.length - 1));
const se = sd / Math.sqrt(diffs.length);
const t = md / se;
console.log(`\npaired graft−bm25 on R@10 (natural): mean ${(md * 100).toFixed(1)} pts, 95% CI [${((md - 1.96 * se) * 100).toFixed(1)}, ${((md + 1.96 * se) * 100).toFixed(1)}], t=${t.toFixed(2)}, n=${diffs.length}`);
console.log(Math.abs(t) > 1.96
  ? '  → the difference is statistically significant at p<0.05.'
  : '  → NOT significant at p<0.05; the honest reading is "no demonstrated difference".');

writeFileSync(join(RES, 'ALL.json'), JSON.stringify({ generatedAt: new Date().toISOString(), repos: loaded.map((d) => d.repo.slug), pooled }, null, 2));
console.log(`\n→ ${join(RES, 'ALL.json')}`);
