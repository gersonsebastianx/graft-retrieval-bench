/**
 * Retriever under test: `graft build` + `graft ask --json`.
 *
 * Build time is measured but NOT charged against the query — a real user builds
 * once and queries many times. Charging it per query would be the mirror image
 * of graft's own inflated accounting, and we are not doing that.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { textTokens } from '../lib/tokens.mjs';

/** The one line an agent actually pays for, per hit. */
function hitCost(h) {
  return textTokens(`${h.title} ${h.pointer} ${h.snippet ?? ''}`);
}

function filePathOf(pointer) {
  return String(pointer || '').split(':')[0].replace(/\\/g, '/');
}

export const name = 'graft';

/**
 * Build the graph once per CASE (per base commit), not per query — a user
 * builds once and queries many times, and both query conditions run against the
 * identical index. Build time is reported separately, never folded into query
 * latency; charging it per query would be the mirror image of graft's own
 * inflated accounting, and we are not doing that.
 */
export async function prepare({ repoDir, graftBin }) {
  // Always cold at this commit: no cache survives a checkout, and a stale one
  // would silently leak the future into the index.
  rmSync(join(repoDir, 'graft'), { recursive: true, force: true });
  const b0 = Date.now();
  try {
    execFileSync(process.execPath, [graftBin, 'build', '.'], {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024, timeout: 900_000,
    });
    return { buildMs: Date.now() - b0 };
  } catch (e) {
    return { buildMs: Date.now() - b0, error: `build: ${String(e.message).slice(0, 200)}` };
  }
}

export async function retrieve({ repoDir, query, k, graftBin, prepared }) {
  const t0 = Date.now();
  const buildMs = prepared?.buildMs ?? null;
  if (prepared?.error) {
    return { ranked: [], entries: [], packTokens: 0, ms: 0, buildMs, error: prepared.error };
  }

  // Fairness fix, found by diagnosing the first run: `ask` ranks SYMBOLS, and
  // several symbols routinely share one file, so `-n k` yielded only ~4.35
  // unique files where the file-ranking baselines got a full 5. Over-request
  // symbols and cut at k UNIQUE files, so every retriever is judged on the same
  // number of file candidates. Cost is then charged for exactly the hits needed
  // to reach that k-th unique file — no more, no less.
  const over = Math.max(k * 4, 20);
  let json;
  try {
    const out = execFileSync(
      process.execPath,
      [graftBin, 'ask', query, '.', '--json', '-n', String(over), '--no-refresh'],
      { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 300_000 },
    );
    json = JSON.parse(out);
  } catch (e) {
    return { ranked: [], entries: [], packTokens: 0, ms: Date.now() - t0, buildMs, error: `ask: ${String(e.message).slice(0, 200)}` };
  }

  const hits = Array.isArray(json.hits) ? json.hits : [];
  const entries = [];
  const ranked = [];
  const seen = new Set();
  for (const h of hits) {
    const p = filePathOf(h.pointer);
    if (!p) continue;
    if (!seen.has(p)) {
      if (ranked.length >= k) break; // k unique files is the shared budget
      seen.add(p);
      ranked.push(p);
    }
    entries.push({ path: p, tokens: hitCost(h) });
  }

  return {
    ranked,
    entries,
    packTokens: entries.reduce((a, e) => a + e.tokens, 0),
    ms: Date.now() - t0,
    buildMs,
    mode: json.mode,
    uniqueFiles: ranked.length,
  };
}
