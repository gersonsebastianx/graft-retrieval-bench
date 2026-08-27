#!/usr/bin/env node
/**
 * Test the two diagnoses of WHY `graft ask` under-retrieves, so they can be
 * reported as measurements rather than hunches.
 *
 *   node bench/verify-hypotheses.mjs --repo pocketbase
 *
 * H1 — MORPHOLOGY. Observation: querying "atomically" did not surface
 *      `writeJsonAtomic`. If graft's tokenizer loses morphological variants,
 *      then feeding it a query pre-expanded with stems and camel splits should
 *      recover recall it is currently leaving on the table. We cannot patch
 *      their tokenizer from here, so we simulate the fix at the input and
 *      measure the delta. A gain means an internal stemmer would pay off.
 *
 * H2 — ONE-HOP. Observation: asking about token-savings returned the two files
 *      that CALL savings.ts, but not savings.ts. If that generalises, graft's
 *      own graph already contains the answer and the ranker fails to walk to
 *      it. Computed directly on their `wiring.json` — no patch, no simulation:
 *      for every gold file graft missed, is it one edge away from a file graft
 *      DID return?
 *
 * H2 is the finding that matters. "Your search is worse than grep" invites an
 * argument about method; "your graph held the answer one edge away in N% of
 * your misses" is actionable and hard to wave off.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { recallAt, mean } from './lib/metrics.mjs';
import { identifierParts } from './lib/query.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...o });

const args = process.argv.slice(2);
const repoId = args[args.indexOf('--repo') + 1];
const K = Number(args[args.indexOf('--k') + 1] || 10);

const casesFile = join(ROOT, 'data', 'cases', `${repoId}.json`);
const { repo, cases } = JSON.parse(readFileSync(casesFile, 'utf8'));
const repoDir = join(ROOT, 'repos', repo.id);
// --graft-bin lets the same harness measure a different graft version, so a
// before/after across releases uses identical cases, queries and scoring.
const binArg = args.includes('--graft-bin') ? args[args.indexOf('--graft-bin') + 1] : null;
const graftBin = binArg || join(dirname(require.resolve('@nanonets/graft/package.json')), 'dist', 'cli.js');
const graftVersion = (() => {
  try { return JSON.parse(readFileSync(join(dirname(graftBin), '..', 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
})();

/** Crude but transparent suffix stripping — no dictionary, no dependency. */
function stem(w) {
  const l = w.toLowerCase();
  for (const s of ['ically', 'ation', 'ically', 'ingly', 'ness', 'ment', 'tion', 'ally', 'ing', 'ed', 'ly', 'es', 's']) {
    if (l.length > s.length + 3 && l.endsWith(s)) return l.slice(0, -s.length);
  }
  return l;
}

/** H1's simulated fix: original terms + stems + camel/snake splits. */
function expandQuery(q) {
  const out = [];
  const seen = new Set();
  for (const w of q.split(/\s+/).filter(Boolean)) {
    for (const t of [w, stem(w), ...identifierParts(w)]) {
      const lt = String(t).toLowerCase();
      if (lt.length < 3 || seen.has(lt)) continue;
      seen.add(lt);
      out.push(t);
    }
  }
  return out.join(' ');
}

const fileOf = (id) => String(id).split('#')[0].replace(/\\/g, '/');

/**
 * Returns the top-k unique files AND the tail that the k cut discarded.
 *
 * The tail is @Frankie-Xu's decomposition (trailhq/Graft#117): a miss sitting in
 * the tail was already GENERATED and merely ranked too low, which is a
 * selection problem. A miss that is one hop away but NOT in the tail is the only
 * part that actually needs new candidates. Lumping both together — as the
 * original write-up did — overstates how much of the gap expansion could fix.
 */
function askFiles(query, k) {
  try {
    const out = sh(process.execPath, [graftBin, 'ask', query, '.', '--json', '-n', String(Math.max(k * 4, 20)), '--no-refresh'],
      { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
    const j = JSON.parse(out);
    const ranked = [];
    const tail = [];
    const seen = new Set();
    for (const h of j.hits || []) {
      const p = String(h.pointer || '').split(':')[0].replace(/\\/g, '/');
      if (!p || seen.has(p)) continue;
      seen.add(p);
      if (ranked.length < k) ranked.push(p); else tail.push(p);
    }
    ranked.tail = tail;
    return ranked;
  } catch { return null; }
}

/** file -> set of files one edge away, in either direction. */
function buildAdjacency(wiring) {
  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of wiring.edges || []) {
    // `contains` is file→its own symbols; it carries no cross-file information
    if (e.relation === 'contains') continue;
    const s = fileOf(e.source), t = fileOf(e.target);
    link(s, t); link(t, s);
  }
  return adj;
}

const rows = [];
const skipped = { checkout: 0, noGold: 0, build: 0, ask: 0 };
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  process.stderr.write(`[${i + 1}/${cases.length}] PR #${c.pr} … `);
  try {
    sh('git', ['clean', '-xdfq'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    sh('git', ['checkout', '--detach', '--force', c.base], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    sh('git', ['clean', '-xdfq'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { skipped.checkout++; process.stderr.write('checkout fail\n'); continue; }

  const present = new Set(sh('git', ['ls-files', '-z'], { cwd: repoDir }).split('\0').filter(Boolean));
  const gold = c.gold.filter((g) => present.has(g));
  if (!gold.length) { skipped.noGold++; process.stderr.write('no gold at base\n'); continue; }

  rmSync(join(repoDir, 'graft'), { recursive: true, force: true });
  try {
    sh(process.execPath, [graftBin, 'build', '.'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 });
  } catch { skipped.build++; process.stderr.write('build fail\n'); continue; }

  const q = c.queries.natural;
  const base = askFiles(q, K);
  const expanded = askFiles(expandQuery(q), K);
  if (!base || !expanded) { skipped.ask++; process.stderr.write('ask fail\n'); continue; }

  // ---- H2, on graft's own graph ----
  const wPath = join(repoDir, 'graft', '.graph', 'wiring.json');
  let oneHop = null, twoHop = null, missed = null, cov1 = null, cov2 = null, nFiles = null;
  let inTail = null, needsNew = null, neither = null;
  if (existsSync(wPath)) {
    const wiring = JSON.parse(readFileSync(wPath, 'utf8'));
    const adj = buildAdjacency(wiring);
    // Candidate universe = every source file graft indexed. The VALIDITY CHECK
    // below needs it: if the 2-hop neighbourhood covers most of the repo, then
    // "the miss was within 2 hops" is arithmetic, not a finding.
    const allFiles = new Set((wiring.nodes || []).filter((n) => n.kind === 'file' && n.path).map((n) => n.path.replace(/\\/g, '/')));
    nFiles = allFiles.size;
    const returned = new Set(base);
    const miss = gold.filter((g) => !returned.has(g));
    missed = miss.length;
    const hop1 = new Set();
    for (const r of returned) for (const n of adj.get(r) || []) hop1.add(n);
    const hop2 = new Set(hop1);
    for (const n of hop1) for (const m of adj.get(n) || []) hop2.add(m);
    for (const r of returned) { hop1.delete(r); hop2.delete(r); }
    // reach expressed as a share of the repo = the chance level for a random file
    cov1 = nFiles ? [...hop1].filter((f) => allFiles.has(f)).length / nFiles : null;
    cov2 = nFiles ? [...hop2].filter((f) => allFiles.has(f)).length / nFiles : null;
    oneHop = miss.filter((g) => hop1.has(g)).length;
    twoHop = miss.filter((g) => hop2.has(g)).length;
    const tail = new Set(base.tail || []);
    inTail = miss.filter((g) => tail.has(g)).length;
    needsNew = miss.filter((g) => hop1.has(g) && !tail.has(g)).length;
    neither = miss.filter((g) => !hop1.has(g) && !tail.has(g)).length;
  }

  rows.push({
    pr: c.pr,
    goldN: gold.length,
    baseR: recallAt(base, gold, K),
    expR: recallAt(expanded, gold, K),
    missed, oneHop, twoHop, cov1, cov2, nFiles, inTail, needsNew, neither,
  });
  process.stderr.write(`base ${(rows.at(-1).baseR * 100).toFixed(0)}% → exp ${(rows.at(-1).expR * 100).toFixed(0)}%  miss ${missed}${missed ? ` (1hop ${oneHop})` : ''}\n`);
}

const b = mean(rows.map((r) => r.baseR));
const e = mean(rows.map((r) => r.expR));
const improved = rows.filter((r) => r.expR > r.baseR).length;
const worsened = rows.filter((r) => r.expR < r.baseR).length;

const totMiss = rows.reduce((a, r) => a + (r.missed || 0), 0);
const tot1 = rows.reduce((a, r) => a + (r.oneHop || 0), 0);
const tot2 = rows.reduce((a, r) => a + (r.twoHop || 0), 0);

console.log(`\n${repo.slug} — ${rows.length} of ${cases.length} cases, k=${K}, graft ${graftVersion}`);
const lost = cases.length - rows.length;
if (lost) {
  // An overnight run silently lost 8 of 45 spring-boot cases to transient
  // failures and reported the degraded set as if it were complete. Loud now.
  console.log(`  ${lost} case(s) not scored: ${JSON.stringify(skipped)}`);
  if (lost / cases.length > 0.1) console.log(`  WARNING: >10% of cases dropped — treat this run as degraded and re-run.`);
}
console.log(`\nH1 MORPHOLOGY (query pre-expanded with stems + camel splits)`);
console.log(`  R@${K} baseline           ${(b * 100).toFixed(1)}%`);
console.log(`  R@${K} expanded query     ${(e * 100).toFixed(1)}%   (Δ ${((e - b) * 100).toFixed(1)} pts)`);
console.log(`  cases improved / worsened  ${improved} / ${worsened}`);

console.log(`\nH2 ONE-HOP (on graft's own wiring.json)`);
console.log(`  gold files graft missed    ${totMiss}`);
console.log(`  of those, 1 edge away      ${tot1}  (${totMiss ? (100 * tot1 / totMiss).toFixed(1) : '0'}%)`);
console.log(`  of those, within 2 edges   ${tot2}  (${totMiss ? (100 * tot2 / totMiss).toFixed(1) : '0'}%)`);
const tTail = rows.reduce((a, r) => a + (r.inTail || 0), 0);
const tNew = rows.reduce((a, r) => a + (r.needsNew || 0), 0);
const tNone = rows.reduce((a, r) => a + (r.neither || 0), 0);
console.log(`\nMISS DECOMPOSITION (per @Frankie-Xu, trailhq/Graft#117)`);
console.log(`  already generated, ranked below k  ${tTail}  (${totMiss ? (100 * tTail / totMiss).toFixed(1) : '0'}%)  -> selection problem`);
console.log(`  1-hop but NOT in the tail          ${tNew}  (${totMiss ? (100 * tNew / totMiss).toFixed(1) : '0'}%)  -> needs new candidates`);
console.log(`  neither                            ${tNone}  (${totMiss ? (100 * tNone / totMiss).toFixed(1) : '0'}%)`);
console.log(`\n  VALIDITY CHECK — is the neighbourhood just most of the repo?`);
console.log(`  mean repo size             ${Math.round(mean(rows.map((r) => r.nFiles)))} indexed files`);
console.log(`  1-hop reach                ${(100 * mean(rows.map((r) => r.cov1))).toFixed(1)}% of the repo  ← chance level`);
console.log(`  2-hop reach                ${(100 * mean(rows.map((r) => r.cov2))).toFixed(1)}% of the repo  ← chance level`);
console.log(`  lift @1hop                 ${(100 * tot1 / totMiss / (100 * mean(rows.map((r) => r.cov1)))).toFixed(1)}x over chance`);
console.log(`  lift @2hop                 ${(100 * tot2 / totMiss / (100 * mean(rows.map((r) => r.cov2)))).toFixed(1)}x over chance`);

// Persist. An earlier run of this script only printed to a log in /tmp, which
// was garbage-collected before the numbers were read — two hours of compute lost
// to a missing writeFileSync.
const outDir = join(ROOT, 'results');
mkdirSync(outDir, { recursive: true });
const payload = {
  repo: repo.id, k: K, graftVersion, generatedAt: new Date().toISOString(), n: rows.length,
  h1: { base: b, expanded: e, improved, worsened },
  h2: {
    missed: totMiss, oneHop: tot1, twoHop: tot2,
    inTail: tTail, needsNew: tNew, neither: tNone,
    cov1: mean(rows.map((r) => r.cov1)), cov2: mean(rows.map((r) => r.cov2)),
    nFiles: mean(rows.map((r) => r.nFiles)),
  },
  rows,
};
const tag = binArg ? `-v${graftVersion}` : '';
writeFileSync(join(outDir, `hypotheses-${repo.id}${tag}.json`), JSON.stringify(payload, null, 2));
console.log(`\n→ ${join(outDir, `hypotheses-${repo.id}${tag}.json`)}`);
console.log(`\n${JSON.stringify({ repo: repo.id, n: rows.length, h1: { base: b, expanded: e }, h2: { missed: totMiss, oneHop: tot1, twoHop: tot2, inTail: tTail, needsNew: tNew, neither: tNone, cov1: mean(rows.map((r) => r.cov1)), cov2: mean(rows.map((r) => r.cov2)), nFiles: mean(rows.map((r) => r.nFiles)) } })}`);
