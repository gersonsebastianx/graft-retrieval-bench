#!/usr/bin/env node
/**
 * The runner.
 *
 *   node bench/run.mjs --repo pocketbase [--k 10] [--budget 400] [--limit N]
 *
 * For every case: hard-reset the clone to the PR's BASE commit, enumerate the
 * candidate source files, run each retriever against the cleaned query, and
 * score the ranked file lists against the files the merged PR actually touched.
 *
 * Nothing here calls a model. Same inputs → same numbers, on any machine.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { recallAt, mrr, anyHit, recallUnderBudget, mean, wilson95 } from './lib/metrics.mjs';
import * as graft from './retrievers/graft.mjs';
import * as bm25 from './retrievers/bm25.mjs';
import * as gitgrep from './retrievers/gitgrep.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const RETRIEVERS = [graft, bm25, gitgrep];
const CONDITIONS = ['natural', 'stemblind'];
const SKIP_PATH = /(^|\/)(vendor|third_party|node_modules|dist|build|testdata|fixtures)\//i;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
}

function resolveGraftBin() {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json');
    return join(dirname(pkg), 'dist', 'cli.js');
  } catch {
    console.error('@nanonets/graft is not installed. Run: npm install');
    process.exit(1);
  }
}

/** Every tracked source file at the current checkout — the shared candidate universe. */
function sourceFilesAt(repoDir, exts) {
  const out = sh('git', ['ls-files', '-z'], { cwd: repoDir });
  return out.split('\0').filter(
    (f) => f && exts.some((e) => f.endsWith(e)) && !SKIP_PATH.test(f),
  );
}

function checkoutBase(repoDir, sha) {
  sh('git', ['clean', '-xdfq'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
  sh('git', ['checkout', '--detach', '--force', sha], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
  sh('git', ['clean', '-xdfq'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
}

function pct(x) { return x === null || x === undefined ? '  —  ' : `${(x * 100).toFixed(1)}%`.padStart(6); }
function num(x, d = 3) { return x === null || x === undefined ? '  —  ' : x.toFixed(d).padStart(6); }

async function main() {
  const args = process.argv.slice(2);
  const repoId = args[args.indexOf('--repo') + 1];
  const K = Number(args[args.indexOf('--k') + 1] || 10);
  const BUDGET = Number(args[args.indexOf('--budget') + 1] || 400);
  const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

  const casesFile = join(ROOT, 'data', 'cases', `${repoId}.json`);
  if (!existsSync(casesFile)) {
    console.error(`no cases for "${repoId}". Run: node bench/fetch-prs.mjs --repo ${repoId} --limit 20`);
    process.exit(1);
  }
  const { repo, cases: allCases } = JSON.parse(readFileSync(casesFile, 'utf8'));
  // Defensive dedupe: a case file with the same PR twice double-counts that PR
  // in every mean and fakes the sample size. This happened (pocketbase: 50 rows,
  // 25 PRs) and the fix belongs at both ends, not only in fetch-prs.
  const seenPr = new Set();
  const deduped = allCases.filter((c) => (seenPr.has(c.pr) ? false : seenPr.add(c.pr)));
  if (deduped.length !== allCases.length) {
    console.log(`note: dropped ${allCases.length - deduped.length} duplicate PR row(s) from the case file`);
  }
  const cases = deduped.slice(0, LIMIT);
  const repoDir = join(ROOT, 'repos', repo.id);
  const graftBin = resolveGraftBin();

  console.log(`\n${repo.slug} · ${cases.length} cases · k=${K} · budget=${BUDGET} tok · conditions=${CONDITIONS.join(',')}\n`);

  const results = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    process.stderr.write(`[${i + 1}/${cases.length}] PR #${c.pr} @ ${c.base.slice(0, 8)} … `);
    try {
      checkoutBase(repoDir, c.base);
    } catch (e) {
      process.stderr.write(`checkout FAILED, skipping\n`);
      continue;
    }
    const sourceFiles = sourceFilesAt(repoDir, repo.exts);

    // Gold files must exist at the base commit. A PR that only ADDS files has
    // no findable target — retrieval cannot surface what isn't there yet, so
    // those cases are excluded rather than counted as universal failures.
    const present = new Set(sourceFiles);
    const gold = c.gold.filter((g) => present.has(g));
    if (!gold.length) {
      process.stderr.write(`all gold files are new at base — excluded\n`);
      continue;
    }

    const row = {
      pr: c.pr, queries: c.queries, querySource: c.querySource,
      gold, goldNew: c.gold.length - gold.length,
      byCondition: {},
    };

    // One index per case, shared by both query conditions and by nothing else.
    const prepared = {};
    for (const r of RETRIEVERS) prepared[r.name] = await r.prepare({ repoDir, graftBin });

    for (const cond of CONDITIONS) {
      const query = c.queries[cond];
      row.byCondition[cond] = {};
      for (const r of RETRIEVERS) {
        const res = await r.retrieve({
          repoDir, query, k: K, sourceFiles, exts: repo.exts, graftBin, prepared: prepared[r.name],
        });
        const budget = recallUnderBudget(res.entries, gold, BUDGET);
        row.byCondition[cond][r.name] = {
          recall1: recallAt(res.ranked, gold, 1),
          recall5: recallAt(res.ranked, gold, 5),
          recall10: recallAt(res.ranked, gold, 10),
          mrr: mrr(res.ranked, gold),
          anyHit: anyHit(res.ranked, gold),
          packTokens: res.packTokens,
          budgetRecall: budget?.recall ?? null,
          ms: res.ms,
          buildMs: res.buildMs ?? null,
          error: res.error ?? null,
          top: res.ranked.slice(0, 5),
        };
      }
    }
    results.push(row);
    const marks = CONDITIONS.map(
      (cond) => `${cond[0]}:[${RETRIEVERS.map((r) => (row.byCondition[cond][r.name].anyHit ? '✓' : '·')).join('')}]`,
    ).join(' ');
    process.stderr.write(`${marks}\n`);
  }

  // ---- aggregate ----
  const summary = {};
  for (const cond of CONDITIONS) {
    summary[cond] = {};
    for (const r of RETRIEVERS) {
      const rows = results.map((x) => x.byCondition[cond][r.name]);
      const hits = rows.filter((x) => x.anyHit).length;
      summary[cond][r.name] = {
        n: rows.length,
        recall1: mean(rows.map((x) => x.recall1)),
        recall5: mean(rows.map((x) => x.recall5)),
        recall10: mean(rows.map((x) => x.recall10)),
        mrr: mean(rows.map((x) => x.mrr)),
        hitRate: rows.length ? hits / rows.length : null,
        hitRateCI: wilson95(hits, rows.length),
        packTokens: mean(rows.map((x) => x.packTokens)),
        budgetRecall: mean(rows.map((x) => x.budgetRecall)),
        ms: mean(rows.map((x) => x.ms)),
        buildMs: mean(rows.map((x) => x.buildMs).filter((v) => v !== null && v !== undefined)),
        errors: rows.filter((x) => x.error).length,
      };
    }
  }

  for (const cond of CONDITIONS) {
    const label = cond === 'natural'
      ? 'NATURAL — the query a developer would actually type'
      : 'STEM-BLIND — filename-derived words removed; isolates non-filename retrieval';
    console.log(`\n${label}`);
    console.log(`${'retriever'.padEnd(10)} ${'R@1'.padStart(6)} ${'R@5'.padStart(6)} ${'R@10'.padStart(6)} ${'MRR'.padStart(6)} ${'hit%'.padStart(6)} ${`R@${BUDGET}tok`.padStart(9)} ${'pack'.padStart(6)} ${'ms'.padStart(7)}`);
    console.log('-'.repeat(76));
    for (const r of RETRIEVERS) {
      const s = summary[cond][r.name];
      console.log(
        `${r.name.padEnd(10)} ${pct(s.recall1)} ${pct(s.recall5)} ${pct(s.recall10)} ${num(s.mrr)} ${pct(s.hitRate)} ${pct(s.budgetRecall).padStart(9)} ${String(Math.round(s.packTokens || 0)).padStart(6)} ${String(Math.round(s.ms || 0)).padStart(7)}`,
      );
    }
    console.log(`hit-rate 95% CI: ${RETRIEVERS.map((r) => `${r.name} [${(summary[cond][r.name].hitRateCI[0] * 100).toFixed(0)}–${(summary[cond][r.name].hitRateCI[1] * 100).toFixed(0)}%]`).join('  ')}`);
  }

  // The number that answers the actual question.
  console.log(`\nfilename-dependence (natural R@10 − stem-blind R@10):`);
  for (const r of RETRIEVERS) {
    const a = summary.natural[r.name].recall10;
    const b = summary.stemblind[r.name].recall10;
    console.log(`  ${r.name.padEnd(10)} ${pct(a)} → ${pct(b)}   Δ ${((a - b) * 100).toFixed(1)} pts`);
  }

  const bMs = summary.natural.graft.buildMs;
  if (bMs) console.log(`\ngraft build: ${(bMs / 1000).toFixed(1)}s avg per case (measured, not charged to query time)`);
  for (const cond of CONDITIONS) {
    for (const r of RETRIEVERS) {
      const e = summary[cond][r.name].errors;
      if (e) console.log(`⚠ ${cond}/${r.name}: ${e} errored case(s)`);
    }
  }

  const outDir = join(ROOT, 'results');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${repo.id}-k${K}-b${BUDGET}.json`);
  writeFileSync(out, JSON.stringify({ repo, k: K, budget: BUDGET, generatedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log(`\n→ ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
