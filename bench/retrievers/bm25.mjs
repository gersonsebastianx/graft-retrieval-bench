/**
 * The baseline that matters: BM25 over raw file contents, no graph, no index
 * artifact, no build step.
 *
 * If graft cannot beat this, the graph is not earning its keep — every claim
 * about "the agent stops re-exploring" reduces to "we shipped a search box".
 * Tokenization is deliberately generous to the baseline (camelCase splitting,
 * same as a decent code search would do) so the comparison is not rigged in the
 * direction we happen to be skeptical of.
 */
import { readFileSync } from 'node:fs';
import { textTokens } from '../lib/tokens.mjs';
import { identifierParts } from '../lib/query.mjs';

const K1 = 1.2;
const B = 0.75;
const MAX_BYTES = 400_000;

function tokenize(text) {
  const out = [];
  for (const raw of String(text).split(/[^A-Za-z0-9_]+/)) {
    if (raw.length < 3) continue;
    const lw = raw.toLowerCase();
    out.push(lw);
    // a query saying "record validation" should match `validateRecord`
    const parts = identifierParts(raw);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

export const name = 'bm25';

/** No index artifact to build — that is the point of this baseline. */
export async function prepare() { return {}; }

export async function retrieve({ repoDir, query, k, sourceFiles }) {
  const t0 = Date.now();

  const docs = [];
  for (const rel of sourceFiles) {
    let text;
    try {
      const buf = readFileSync(`${repoDir}/${rel}`);
      if (buf.length > MAX_BYTES) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const tf = new Map();
    // the path itself is legitimate signal for any file-level search
    for (const t of tokenize(`${rel} ${text}`)) tf.set(t, (tf.get(t) || 0) + 1);
    docs.push({ path: rel, tf, len: [...tf.values()].reduce((a, b) => a + b, 0) });
  }
  if (!docs.length) return { ranked: [], entries: [], packTokens: 0, ms: Date.now() - t0, error: 'no source files' };

  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / N;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);

  const qTerms = [...new Set(tokenize(query))];
  const scored = [];
  for (const d of docs) {
    let s = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgdl))));
    }
    if (s > 0) scored.push({ path: d.path, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const top = scored.slice(0, k);
  // What an agent would pay to see this list: one path line per result.
  const entries = top.map((r) => ({ path: r.path, tokens: textTokens(r.path) }));

  return {
    ranked: top.map((r) => r.path),
    entries,
    packTokens: entries.reduce((a, e) => a + e.tokens, 0),
    ms: Date.now() - t0,
  };
}
