#!/usr/bin/env node
/**
 * Build the case set for one repo from its merged-PR history.
 *
 *   node bench/fetch-prs.mjs --repo pocketbase --limit 20
 *
 * A case is admitted only if every one of these holds. The filters are strict on
 * purpose: a benchmark's credibility is decided by what it refuses to measure.
 *
 *   - the PR is merged, and its merge commit resolves in the local clone
 *   - it touches 1..MAX_FILES source files of the repo's language
 *   - it is not a dependency bump / release chore / docs-only / generated-code PR
 *   - after stripping, the query still has >= MIN_QUERY_WORDS content words
 *   - the leak audit finds ZERO gold-derived tokens left in the query
 *
 * Base commit = merge_commit_sha^1 — the exact state of the base branch the
 * instant before the PR landed. Building the graph anywhere else (HEAD, say)
 * leaks the fix into the index and invalidates the whole run.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuery, auditQuery, repoBoilerplate } from './lib/query.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = JSON.parse(
  execFileSync('cat', [join(ROOT, 'bench', 'corpus.json')], { encoding: 'utf8' }),
);

const MAX_FILES = 10;
const MIN_QUERY_WORDS = 8;

const SKIP_TITLE = /^(bump|chore\(deps\)|build\(deps\)|release|v?\d+\.\d+\.\d+|merge |revert |update changelog|prepare release|back to development)/i;
const SKIP_PATH = /(^|\/)(vendor|third_party|node_modules|dist|build|\.github|docs?|examples?|testdata|fixtures|migrations)\//i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(_test|\.test|\.spec|Test|Tests)\.[A-Za-z]+$/;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/**
 * One page, one call. NOT `--paginate`: this file paginates explicitly via the
 * `page=` param, and combining the two makes gh follow every Link header in the
 * repo — thousands of pages on django/spring-boot, which blew past maxBuffer,
 * threw, and silently produced "0 cases, 0 rejected". A fetch that finds nothing
 * must look different from a fetch that rejects everything, so failures are
 * surfaced now instead of swallowed.
 */
function gh(path, { quiet = false } = {}) {
  try {
    return JSON.parse(sh('gh', ['api', path], { stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    if (!quiet) process.stderr.write(`  ! gh api failed: ${path.slice(0, 80)} — ${String(e.message).split('\n')[0].slice(0, 120)}\n`);
    return null;
  }
}

/** Clone (or reuse) a bare-ish full clone we can check out base commits from. */
function ensureClone(repo, reposDir) {
  const dir = join(reposDir, repo.id);
  if (existsSync(join(dir, '.git'))) {
    process.stderr.write(`  clone: reusing ${dir}\n`);
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  process.stderr.write(`  clone: fetching ${repo.slug} (full history, this is the slow part)\n`);
  sh('git', ['clone', '--filter=blob:none', `https://github.com/${repo.slug}.git`, dir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return dir;
}

function linkedIssue(slug, body) {
  const m = String(body || '').match(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*#(\d+)/i);
  if (!m) return null;
  const issue = gh(`repos/${slug}/issues/${m[1]}`, { quiet: true });
  if (!issue || issue.pull_request) return null;
  return { number: issue.number, title: issue.title, body: issue.body };
}

async function main() {
  const args = process.argv.slice(2);
  const repoId = args[args.indexOf('--repo') + 1];
  const limit = Number(args[args.indexOf('--limit') + 1] || 20);
  const scan = Number(args[args.indexOf('--scan') + 1] || Math.max(120, limit * 8));

  const repo = CORPUS.repos.find((r) => r.id === repoId);
  if (!repo) {
    console.error(`unknown repo "${repoId}". known: ${CORPUS.repos.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }

  const reposDir = join(ROOT, 'repos');
  mkdirSync(reposDir, { recursive: true });
  const clone = ensureClone(repo, reposDir);

  process.stderr.write(`  scanning up to ${scan} merged PRs for ${repo.slug}…\n`);
  // Dedupe by PR number while paging. `sort=updated` reorders under us on an
  // active repo, so the same PR can land on more than one page — which silently
  // produced 50 rows over 25 unique PRs for pocketbase, double-counting half the
  // set in every mean. Caught by @Frankie-Xu on issue #117; see DEDUPE-FIX in
  // the README.
  const perPage = 100;
  const pages = Math.ceil(scan / perPage);
  const byNumber = new Map();
  for (let p = 1; p <= pages; p++) {
    const batch = gh(`repos/${repo.slug}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${p}`);
    if (!batch || !batch.length) break;
    for (const pr of batch) if (pr.merged_at && !byNumber.has(pr.number)) byNumber.set(pr.number, pr);
    if (byNumber.size >= scan) break;
  }
  const prs = [...byNumber.values()];
  process.stderr.write(`  ${prs.length} merged PRs to filter\n`);
  if (!prs.length) {
    console.error(`\nFATAL: 0 merged PRs returned for ${repo.slug}. This is an API/paging failure, not a filtering result — refusing to write an empty case file.`);
    process.exit(2);
  }

  const cases = [];
  const candidates = [];
  const rejected = { title: 0, files: 0, base: 0, query: 0, leak: 0 };

  const admitted = new Set();
  for (const pr of prs) {
    if (candidates.length >= limit) break;
    if (admitted.has(pr.number)) continue; // belt and braces alongside the paging dedupe
    admitted.add(pr.number);
    if (SKIP_TITLE.test(pr.title || '')) { rejected.title++; continue; }
    if (!pr.merge_commit_sha) { rejected.base++; continue; }

    // Resolve the pre-merge state locally. If the commit isn't in our clone
    // (force-pushed, deleted branch), the case is unusable — drop it.
    let base;
    try {
      base = sh('git', ['rev-parse', `${pr.merge_commit_sha}^1`], { cwd: clone, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { rejected.base++; continue; }

    const files = gh(`repos/${repo.slug}/pulls/${pr.number}/files`);
    if (!files) { rejected.files++; continue; }

    const changed = files.map((f) => f.filename);
    const gold = changed.filter(
      (f) => repo.exts.some((e) => f.endsWith(e)) && !SKIP_PATH.test(f) && !TEST_PATH.test(f),
    );
    if (gold.length < 1 || gold.length > MAX_FILES) { rejected.files++; continue; }

    // Query source: the linked issue when there is one (written before anyone
    // knew the fix), else the PR itself.
    const issue = linkedIssue(repo.slug, pr.body);
    const primary = issue || { title: pr.title, body: pr.body };

    candidates.push({ pr, base, changed, gold, issue, primary });
  }

  // ---- pass 2: strip this repo's PR-template boilerplate, then build queries ----
  // Must happen after all candidates are known: boilerplate is defined by what
  // repeats ACROSS this repo's PRs, which is not observable one PR at a time.
  const boilerplate = repoBoilerplate(
    candidates.map((c) => `${c.primary.title || ''} ${c.primary.body || ''}`),
  );
  process.stderr.write(`  repo boilerplate: ${boilerplate.size} token(s) in >=50% of PR texts\n`);

  for (const { pr, base, changed, gold, issue, primary } of candidates) {
    if (cases.length >= limit) break;

    // Contamination defense runs against EVERY changed file, not just gold —
    // a test filename leaks the source filename just as effectively.
    const natural = buildQuery(primary, changed, { mode: 'natural', boilerplate });
    const stemblind = buildQuery(primary, changed, { mode: 'stemblind', boilerplate });

    // The NATURAL query sets admission: it is the realistic condition. A case
    // whose stem-blind variant collapses is still admitted and simply scores
    // low for everyone — that collapse is a property of the PR, and hiding it
    // would flatter whichever tool happens to lean on filenames.
    if (natural.query.split(/\s+/).filter(Boolean).length < MIN_QUERY_WORDS) { rejected.query++; continue; }

    // Hard gate, both conditions: no literal path or filename.with.ext survives.
    if (auditQuery(natural.query, changed).length || auditQuery(stemblind.query, changed).length) {
      rejected.leak++;
      continue;
    }

    cases.push({
      repo: repo.id,
      slug: repo.slug,
      lang: repo.lang,
      pr: pr.number,
      title: pr.title,
      querySource: issue ? `issue#${issue.number}` : 'pr',
      base,
      mergeCommit: pr.merge_commit_sha,
      queries: {
        natural: natural.query,
        stemblind: stemblind.query,
      },
      stemblindWords: stemblind.query.split(/\s+/).filter(Boolean).length,
      rawTitle: primary.title || '',
      rawBody: (primary.body || '').slice(0, 8000),
      droppedBoilerplate: natural.droppedBoilerplate,
      gold,
      changedAll: changed,
      droppedForLeak: stemblind.droppedForLeak,
    });
    process.stderr.write(`  + PR #${pr.number} (${gold.length} gold, src=${issue ? 'issue' : 'pr'}, blind=${stemblind.query.split(/\s+/).filter(Boolean).length}w)\n`);
  }

  const outDir = join(ROOT, 'data', 'cases');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${repo.id}.json`);
  writeFileSync(out, JSON.stringify({
    repo, generatedAt: new Date().toISOString(), rejected,
    boilerplate: [...boilerplate].sort(),
    cases,
  }, null, 2));

  console.log(`\n${cases.length} cases → ${out}`);
  console.log(`rejected: ${JSON.stringify(rejected)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
