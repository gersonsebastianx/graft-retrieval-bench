/**
 * Query construction + contamination defense.
 *
 * The whole benchmark hinges on this file. A PR body that says "fixed in
 * apis/record_crud.go" turns retrieval into string matching, and every number
 * downstream becomes meaningless. So we strip, aggressively and verifiably:
 *
 *   1. fenced code blocks and inline code   (they carry identifiers + paths)
 *   2. URLs                                  (PR/issue links leak repo paths)
 *   3. anything that looks like a file path  (a/b/c.go, ./x/y.py)
 *   4. any token derived from a GOLD FILE    (basename, stem, camel/snake parts)
 *   5. HTML comments + PR template boilerplate
 *
 * (4) is the one that matters most and it is why `clean()` takes the gold set:
 * we remove the answer from the question. `auditQuery` re-checks the result and
 * refuses to emit a case whose query still contains a gold-derived token, so a
 * leak is a hard failure, not a silent bias.
 *
 * Query source preference: the linked ISSUE text beats the PR text, because the
 * issue was written by someone who did not yet know the fix. That is the closest
 * thing to "what a developer asks before they know the answer".
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'this',
  'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'it', 'its',
  'i', 'we', 'you', 'they', 'he', 'she', 'my', 'our', 'your', 'their',
  'not', 'no', 'yes', 'so', 'than', 'too', 'very', 'can', 'will', 'just',
  'should', 'would', 'could', 'may', 'might', 'must', 'do', 'does', 'did',
  'have', 'has', 'had', 'get', 'got', 'also', 'there', 'here', 'what', 'which',
  'who', 'whom', 'how', 'why', 'where', 'all', 'any', 'both', 'each', 'more',
  'most', 'other', 'some', 'such', 'only', 'own', 'same', 'about', 'into',
  'through', 'during', 'after', 'before', 'above', 'below', 'up', 'down', 'out',
  'off', 'over', 'under', 'again', 'once', 'because', 'while', 'until',
  // PR/issue boilerplate
  'please', 'thanks', 'thank', 'hi', 'hello', 'pr', 'issue', 'fix', 'fixes',
  'fixed', 'close', 'closes', 'closed', 'resolve', 'resolves', 'resolved',
  'description', 'summary', 'checklist', 'changelog', 'signed', 'note',
]);

/** Split an identifier into its human words: recordCrud → [record, crud]. */
export function identifierParts(name) {
  return String(name)
    .replace(/\.[A-Za-z0-9]+$/, '')          // drop extension
    .split(/[^A-Za-z0-9]+/)                   // snake_case, kebab-case, dots
    .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])/)) // camelCase
    .flatMap((p) => p.split(/(?<=[A-Z])(?=[A-Z][a-z])/)) // HTTPServer → HTTP|Server
    .map((p) => p.toLowerCase())
    .filter((p) => p.length >= 3);
}

/**
 * Every token that could leak a gold file's identity: full path, path segments,
 * basename, stem, and the stem's identifier parts.
 */
export function goldTokens(goldFiles) {
  const out = new Set();
  for (const f of goldFiles) {
    const posix = f.replace(/\\/g, '/');
    out.add(posix.toLowerCase());
    const segs = posix.split('/');
    const base = segs[segs.length - 1];
    const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
    out.add(base.toLowerCase());
    out.add(stem.toLowerCase());
    out.add(stem.replace(/[_-]/g, '').toLowerCase());
    // directory segments carry signal too (apis/, tools/filesystem/)
    for (const s of segs.slice(0, -1)) if (s.length >= 3) out.add(s.toLowerCase());
    for (const p of identifierParts(stem)) out.add(p);
  }
  out.delete('');
  return out;
}

/** Strip markup that reliably carries identifiers or paths. */
function stripMarkup(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')                 // inline code
    .replace(/<!--[\s\S]*?-->/g, ' ')           // HTML comments (PR templates)
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')        // raw HTML tags
    .replace(/https?:\/\/\S+/g, ' ')            // URLs
    .replace(/\b[\w.-]+\/[\w./-]+\b/g, ' ')     // path-ish tokens: a/b/c.go
    .replace(/\b[\w-]+\.(go|py|ts|tsx|js|jsx|java|rb|rs|c|h|cpp|cs|php|kt|swift|scala|ex|sol|md|json|yml|yaml|txt|sql|html|css)\b/gi, ' ')
    .replace(/#\d+/g, ' ')                      // issue refs
    .replace(/\b[0-9a-f]{7,40}\b/gi, ' ');      // commit shas
}

/**
 * Build the query for a case, under one of two conditions.
 *
 * Validating on 20 PocketBase cases exposed a design error worth recording,
 * because it silently destroys a benchmark: stripping every token that matches
 * a gold filename ALSO strips the domain noun the question is about.
 *
 *   PR #6690 touches tools/auth/patreon.go. Blanket-stripping left:
 *     "refactor update use merged recently adding endpoint released ..."
 *   No retriever on earth finds that file from that text. Scoring it measures
 *   nothing, and it deflates every tool equally — hiding real differences.
 *
 * The actual leak is a PR body that names a PATH ("fixed in tools/auth/patreon.go").
 * A body that says "the Patreon provider is broken" is just… the question. Real
 * developers say domain nouns, and codebases are named after their domain.
 * Penalising that penalises well-named code, not the retriever.
 *
 * So we measure both, and report the delta:
 *
 *   'natural'   — strip paths, filenames-with-extension, code, URLs. The
 *                 realistic setting: what a developer actually types.
 *   'stemblind' — additionally strip every gold-filename-derived token. Brutal,
 *                 often unanswerable, but it isolates one question: does the
 *                 tool do ANYTHING beyond matching the query against filenames?
 *
 * natural − stemblind = how much of a tool's score is filename matching. For a
 * product whose pitch is "a graph of your codebase", that gap is the claim.
 *
 * @param {{title:string, body:string}} primary  issue when available, else PR
 * @param {string[]} goldFiles                   the files the merged PR touched
 * @param {{mode?: 'natural'|'stemblind', maxWords?: number}} opts
 */
/**
 * Repo-level PR boilerplate: tokens that appear in at least `minShare` of a
 * repo's PR texts.
 *
 * Found after the fact, and it mattered: 51.9% of every nest query was the
 * NestJS PR template ("commit message follows guidelines", "Tests changes
 * added", "Bugfix Feature Code style update formatting…"). Because queries are
 * capped at `maxWords`, that boilerplate was *evicting real signal* — nest
 * queries all sat at 52–60 words of mostly checklist. django was 26.5%;
 * pocketbase and spring-boot 0%.
 *
 * The definition is deliberately mechanical rather than a hand-written stop
 * list: a word in half a repo's PRs cannot discriminate between those PRs, so
 * it is noise by construction. It is stripped for every retriever equally, and
 * the stripped set is written into the case file so the choice is auditable.
 */
export function repoBoilerplate(texts, minShare = 0.5) {
  const df = new Map();
  for (const t of texts) {
    const seen = new Set(
      String(t).split(/[^A-Za-z0-9_]+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 3),
    );
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const n = texts.length || 1;
  const out = new Set();
  for (const [w, c] of df) if (c / n >= minShare) out.add(w);
  return out;
}

export function buildQuery(primary, goldFiles, opts = {}) {
  const { mode = 'natural', maxWords = 60, boilerplate = null } = opts;
  const gold = goldTokens(goldFiles);
  const raw = `${primary.title || ''}. ${primary.body || ''}`;
  const stripped = stripMarkup(raw);

  const words = stripped
    .split(/[^A-Za-z0-9_]+/)
    .map((w) => w.trim())
    .filter(Boolean);

  const kept = [];
  const dropped = [];
  const droppedBoiler = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.length < 3) continue;
    if (STOPWORDS.has(lw)) continue;
    if (/^\d+$/.test(lw)) continue;
    // Repo PR-template noise, removed before the word cap so that real signal
    // gets the budget instead of the checklist.
    if (boilerplate && boilerplate.has(lw)) { droppedBoiler.push(lw); continue; }
    if (mode === 'stemblind') {
      if (gold.has(lw) || gold.has(lw.replace(/[_-]/g, ''))) { dropped.push(lw); continue; }
      if (identifierParts(lw).some((p) => gold.has(p))) { dropped.push(lw); continue; }
    }
    kept.push(w);
    if (kept.length >= maxWords) break;
  }

  return {
    query: kept.join(' '),
    droppedForLeak: [...new Set(dropped)],
    droppedBoilerplate: [...new Set(droppedBoiler)],
  };
}

/**
 * Hard leak audit, applied in BOTH conditions: a literal path or a
 * filename-with-extension must never survive into any query. This is the leak
 * that would make the numbers fraudulent; the stem question above is a
 * measurement choice, this is a correctness gate.
 */
export function auditQuery(query, goldFiles) {
  const q = ` ${String(query).toLowerCase()} `;
  const leaks = [];
  for (const f of goldFiles) {
    const posix = f.replace(/\\/g, '/').toLowerCase();
    const base = posix.split('/').pop();
    if (q.includes(posix)) leaks.push(posix);
    if (base && /\.[a-z0-9]+$/.test(base) && q.includes(base)) leaks.push(base);
  }
  return [...new Set(leaks)];
}

/** Stem-blind audit: no gold-derived token at all. Only for the hard condition. */
export function auditStemBlind(query, goldFiles) {
  const gold = goldTokens(goldFiles);
  const leaks = [];
  for (const w of String(query).split(/[^A-Za-z0-9_]+/)) {
    const lw = w.toLowerCase();
    if (lw.length < 3) continue;
    if (gold.has(lw) || gold.has(lw.replace(/[_-]/g, ''))) leaks.push(lw);
    else if (identifierParts(lw).some((p) => gold.has(p))) leaks.push(lw);
  }
  return [...new Set(leaks)];
}

/** Content words, for the keyword-grep baseline. */
export function keywords(query, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const w of String(query).split(/[^A-Za-z0-9_]+/)) {
    const lw = w.toLowerCase();
    if (lw.length < 4 || STOPWORDS.has(lw) || seen.has(lw)) continue;
    seen.add(lw);
    out.push(lw);
    if (out.length >= limit) break;
  }
  return out;
}
