#!/usr/bin/env node
/**
 * The token question, measured honestly.
 *
 *   node bench/skeleton-savings.mjs --repo pocketbase [--n 120]
 *
 * `graft skeleton <file>` is the one command whose savings claim has an honest
 * baseline: the realistic alternative to "show me this file's API surface" IS
 * reading the file, because that is what an agent actually does when it needs
 * a file's signatures. So skeleton-vs-whole-file is a fair comparison — unlike
 * graft's own global counter, which charges every query against "you'd have
 * read every covered file whole", something no agent does.
 *
 * Reported per file and pooled, with the distribution — because a mean alone
 * hides that the saving inverts on small files, where the skeleton costs more
 * than the source it summarises.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { toTokens } from './lib/tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CORPUS = JSON.parse(readFileSync(join(ROOT, 'bench', 'corpus.json'), 'utf8'));

const args = process.argv.slice(2);
const repoId = args[args.indexOf('--repo') + 1];
const N = Number(args[args.indexOf('--n') + 1] || 120);

const repo = CORPUS.repos.find((r) => r.id === repoId);
if (!repo) { console.error(`unknown repo ${repoId}`); process.exit(1); }

const repoDir = join(ROOT, 'repos', repo.id);
const graftBin = join(dirname(require.resolve('@nanonets/graft/package.json')), 'dist', 'cli.js');
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...o });

// Measure at the repo's real head, not a benchmark checkout.
sh('git', ['clean', '-xdfq'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
sh('git', ['checkout', '--force', '-q', sh('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).trim()], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });

process.stderr.write(`building graph for ${repo.slug}…\n`);
const t0 = Date.now();
sh(process.execPath, [graftBin, 'build', '.'], { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 });
process.stderr.write(`  built in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const files = sh('git', ['ls-files', '-z'], { cwd: repoDir })
  .split('\0')
  .filter((f) => f && repo.exts.some((e) => f.endsWith(e)) && !/(^|\/)(vendor|node_modules|testdata)\//.test(f));

// Even spread across the tree, not the first N alphabetically.
const step = Math.max(1, Math.floor(files.length / N));
const sample = files.filter((_, i) => i % step === 0).slice(0, N);

const rows = [];
for (const f of sample) {
  let full;
  try { full = toTokens(readFileSync(join(repoDir, f), 'utf8')); } catch { continue; }
  if (!full) continue;
  let skel;
  try {
    const out = sh(process.execPath, [graftBin, 'skeleton', f, '.', '--no-refresh'], {
      cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
    // strip graft's own savings header so we measure the payload, not its ad
    skel = toTokens(out.replace(/^\[graft\][^\n]*\n\n?/, ''));
  } catch { continue; }
  rows.push({ f, full, skel, saved: full - skel, ratio: skel / full });
}

if (!rows.length) { console.error('no measurable files'); process.exit(1); }

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const totalFull = sum(rows.map((r) => r.full));
const totalSkel = sum(rows.map((r) => r.skel));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const worse = rows.filter((r) => r.skel >= r.full);

console.log(`\n${repo.slug} — graft skeleton vs reading the file whole`);
console.log(`  files measured        ${rows.length}`);
console.log(`  whole files           ${totalFull.toLocaleString()} tok`);
console.log(`  skeletons             ${totalSkel.toLocaleString()} tok`);
console.log(`  pooled reduction      ${(100 * (1 - totalSkel / totalFull)).toFixed(1)}%`);
console.log(`  median per-file       ${(100 * (1 - median(rows.map((r) => r.ratio)))).toFixed(1)}%`);
console.log(`  files where skeleton costs MORE: ${worse.length} (${(100 * worse.length / rows.length).toFixed(0)}%)`);
const big = rows.filter((r) => r.full >= 1000);
if (big.length) {
  console.log(`  files >= 1000 tok:    ${big.length} files, reduction ${(100 * (1 - sum(big.map((r) => r.skel)) / sum(big.map((r) => r.full)))).toFixed(1)}%`);
}
