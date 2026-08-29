> **Historical.** This is the text posted as the opening comment of
> [trailhq/Graft#117](https://github.com/trailhq/Graft/issues/117) on 2026-08-14.
> Its figures are **v1 and superseded** — n=186 double-counted half of pocketbase
> and every query carried PR-template boilerplate. Current numbers and the full
> errata are in [the README](README.md#corrections). Kept as the record of what
> was actually said, not as a result.

# Retrieval measurement: `ask` misses files its own graph holds one edge away (186 PRs, 4 languages)

Hi — I wanted to evaluate graft properly before adopting it, so I built a
retrieval harness and ran it against 186 merged PRs across four repos. Sharing
the results because one of them looks like a concrete, cheap improvement rather
than a complaint. Everything below is reproducible and cost $0 to produce:
no judge model, no API key.

For transparency: I built and ran this with the assistance of a coding agent.
The method, the fairness corrections and the discarded results in §3 were all
worked through and verified rather than taken on trust — the harness is public
so you can check any of it yourself.

Harness: https://github.com/gersonsebastianx/graft-retrieval-bench

## Method, briefly

Ground truth comes from git: for each merged PR the issue/PR text is the query
and the source files the maintainers changed are the correct answer. The graph
is built at `merge_commit_sha^1` — the base commit — so the index can never
contain the fix. Queries are stripped of paths, filenames and code blocks, with
a hard audit that rejects any case where a literal filename survives.

Repos: pocketbase (Go), django (Python), nestjs/nest (TS), spring-boot (Java).
186 cases, k=10. Measured against **`@nanonets/graft` 0.10.1** (latest on npm at
the time of writing), default `graft build` — no `--deep`, no LSP enrichment.

## 1. `ask` trails a no-graph BM25 baseline

| retriever | R@1 | R@5 | R@10 | MRR | hit% | tok/query |
|---|---|---|---|---|---|---|
| `graft ask` | 13.2% | 37.0% | 48.5% | 0.293 | 57.5% | 811 |
| BM25 over raw files (no graph) | 26.9% | 56.1% | 66.5% | 0.449 | 75.3% | 147 |
| `git grep` on keywords | 10.4% | 37.1% | 47.0% | 0.244 | 53.8% | 142 |

Paired over the 186 cases: **−18.0 pts on R@10**, 95% CI [−24.4, −11.5],
t = −5.46. It trails on all four repos; the widest gap is TypeScript
(27.7% vs 65.7%).

Two fairness notes, since both moved the numbers in graft's favour and I'd
rather surface them than be asked. First: `ask` ranks symbols, and several
symbols routinely share one file, so asking for `-n k` returns fewer than k
distinct files — over the top-5 I sampled, 4.35 unique files against 5.00 for
the file-ranking baselines. The harness now over-requests symbols and cuts at
*k unique files*, so every retriever is judged on the same number of candidates;
on the 20-case validation set that change moved graft's R@10 from 47.5% to
57.5%. Second: build time is measured separately and never charged to query
latency, since you build once and query many times.

## 2. The actionable part: the answer is usually one edge away

This is computed directly on graft's own `wiring.json`, no patch involved. For
every gold file `ask` missed, I checked whether it sits one edge (`imports` /
`calls` / `extends`) from a file `ask` *did* return:

| repo | indexed files | misses | captured at 1 hop | neighbourhood reach | lift vs chance |
|---|---|---|---|---|---|
| pocketbase | 283 | 76 | 52.6% | 20.4% | 2.6× |
| nest | 1,746 | 49 | 4.1% | 2.4% | 1.7× |
| django | 2,962 | 47 | 46.8% | 6.2% | 7.6× |
| spring-boot | 8,483 | 43 | 34.9% | 0.8% | **45.0×** |
| **pooled** | | **215** | **36.7%** | **7.8%** | **4.7×** |

**36.7% of the files `ask` misses are one edge from a file it already
returned**, against a 7.8% chance level. The effect grows with repo size — in
spring-boot that neighbourhood is 0.8% of the tree and still contains a third
of the misses.

The reading I take from this: the extractor is doing its job. The edges are
there and they are pointing at the right files. `ask` ranks nodes and does not
walk them. A one-hop expansion after the lexical stage — take the top-k, pull
their `imports`/`calls` neighbours, re-rank with a decay — looks like it could
recover a large share of the gap without touching extraction, without
embeddings, and without giving up the `$0, no key` property.

`graphrank.ts` exists, so some of this is presumably already intended; the
measurement suggests the edge weighting is too weak to change the ranking in
practice.

**Two caveats I'd raise against my own finding**, because they bound what it
supports:

1. **This is a candidate-generation signal, not a free win.** That
   neighbourhood is 42–183 files in absolute terms (58 in pocketbase, 42 in
   nest, 183 in django, 66 in spring-boot). "The answer is in there" is not the
   same as "expansion improves ranking" — pulling those in also pulls in a lot
   of wrong files, and naive expansion could cost precision. What the numbers
   establish is that the information is present and reachable; whether it
   converts into R@10 needs a prototype, which is why I'm not claiming a
   predicted gain.
2. **It is weakest exactly where graft is weakest.** nest has both the widest
   gap vs the baseline and the smallest lift (1.7×). So one-hop expansion would
   likely *not* fix the TypeScript case, and whatever is happening there looks
   like a different problem.

## 3. Things I got wrong, for calibration

I had a second hypothesis and it was wrong, so I'm reporting it rather than
quietly dropping it:

- **Tokenisation/stemming — refuted.** I noticed a query for "atomically"
  failing to surface `writeJsonAtomic` and assumed missing morphological
  handling. Pre-expanding queries with stems and camelCase splits **does not
  help**: 48.5% → 47.6% pooled (−1.0 pts), and the sign disagrees across repos.
  The observation was real; my generalisation from it was not.
- **A "2-hop" version of finding 2 — discarded.** It captured 64.5% of misses,
  which looked like the headline until I computed the chance level: the 2-hop
  neighbourhood covers ~69% of pocketbase, i.e. below chance there and only
  1.3× pooled. A reach-vs-chance check is now part of the script. Without it I
  would have published a non-result as a finding.

## 4. Scope — what this does not show

- It measures **`ask` only**. It says nothing about `map`, `callers`,
  `skeleton` or the MCP tools. I measured `skeleton` separately and it reduces
  tokens 76–91% vs reading the file whole, which is a real saving with an
  honest baseline.
- It measures **retrieval**, not end-to-end agent correctness or cost, and it
  does not speak to the SWE-bench Verified results.
- Engineering quality is not what I'm questioning: 622 tests pass, the
  tree-sitter tier is deterministic and genuinely fast (1.8s on 153 files), and
  there is no telemetry.

## 5. Minor: the reproduce instruction doesn't resolve

https://graft.nanonets.ai says *"Reproduce with `npm run bench`"*, but as of
0.10.1 there is no `bench` script in `package.json` and no benchmark harness in
the repo — which is why I built one rather than reproducing yours. If it lives
somewhere else, pointing at it would be enough and I'd happily re-run against
your method instead of mine.

Relatedly, the site reports correctness as "+5 points" and calls SWE-bench
"(provisional)", while the README reports "+12 pts" (27/50 → 33/50); it isn't
obvious which supersedes which.

Happy to run any variant you'd find more informative — different `k`, different
repos, `--deep` enabled, or the one-hop expansion measured properly if you
prototype it. The harness takes a repo slug and does the rest.
