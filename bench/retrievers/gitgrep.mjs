/**
 * The naive floor: keyword grep, ranked by how many query keywords a file
 * matches (then by match count). Uses `git grep` — a real external tool, so the
 * floor is not something we implemented and could accidentally tune.
 *
 * (ripgrep was specified; it is not installed on this machine and `git grep` is
 * the same class of tool — fixed-string, case-insensitive, whole-tree — while
 * being available anywhere git is, which makes the harness reproducible without
 * an extra binary. Swap in `rg` by changing this file only.)
 */
import { execFileSync } from 'node:child_process';
import { textTokens } from '../lib/tokens.mjs';
import { keywords } from '../lib/query.mjs';

export const name = 'gitgrep';

export async function prepare() { return {}; }

export async function retrieve({ repoDir, query, k, exts }) {
  const t0 = Date.now();
  const kws = keywords(query, 8);
  if (!kws.length) return { ranked: [], entries: [], packTokens: 0, ms: Date.now() - t0, error: 'no keywords' };

  // path filters keep the floor honest: same candidate universe as the others
  const pathspec = exts.map((e) => `*${e}`);
  const perFile = new Map(); // path -> { kws:Set, matches:number }

  for (const kw of kws) {
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '-I', '-i', '-F', '-c', '--', kw, ...pathspec],
        { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      );
    } catch { continue; } // git grep exits 1 on no match
    for (const line of out.split('\n')) {
      if (!line) continue;
      const i = line.lastIndexOf(':');
      if (i < 0) continue;
      const path = line.slice(0, i).replace(/\\/g, '/');
      const count = Number(line.slice(i + 1)) || 0;
      const e = perFile.get(path) || { kws: new Set(), matches: 0 };
      e.kws.add(kw);
      e.matches += count;
      perFile.set(path, e);
    }
  }

  const scored = [...perFile.entries()]
    .map(([path, e]) => ({ path, distinct: e.kws.size, matches: e.matches }))
    .sort((a, b) => b.distinct - a.distinct || b.matches - a.matches || a.path.localeCompare(b.path))
    .slice(0, k);

  const entries = scored.map((r) => ({ path: r.path, tokens: textTokens(r.path) }));
  return {
    ranked: scored.map((r) => r.path),
    entries,
    packTokens: entries.reduce((a, e) => a + e.tokens, 0),
    ms: Date.now() - t0,
    keywords: kws,
  };
}
