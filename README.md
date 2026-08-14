# graft-retrieval-bench

A deterministic, **$0**, reproducible retrieval benchmark for code-context tools.

Built because [@nanonets/graft](https://github.com/nanonets/graft) publishes strong
efficiency numbers, tells you to *"Reproduce with `npm run bench`"* on its website,
and ships **no `bench` script and no harness of any kind** — the string `bench`
does not appear anywhere in that repository.

This is that missing harness. No judge model, no API key, no LLM call.

```bash
npm install
node bench/fetch-prs.mjs --repo pocketbase --limit 20   # build the case set
node bench/run.mjs       --repo pocketbase --k 10       # score the retrievers
```

## What it measures

**Ground truth comes free from git.** For each merged PR: the issue/PR text is
the query, and the source files the maintainers actually changed are the correct
answer. We then ask each retriever for a ranked list of files and score it.

- `recall@1 / @5 / @10` — fraction of gold files surfaced in the top-k
- `MRR` — 1 / rank of the first correct file
- `hit%` — did it find *anything* correct (with a Wilson 95% interval)
- `R@Ntok` — **recall under a fixed token budget**, the only comparison that is
  actually fair: a tool returning 200 results has great recall and no value,
  because the agent pays for the whole pack

## The three rules that make it honest

**1. The graph is built at the PR's BASE commit.** `merge_commit_sha^1` — the
state of the branch the instant before the PR landed. Build anywhere else (HEAD,
say) and the index already contains the fix. This is the single easiest way to
produce beautiful, meaningless numbers.

**2. The query never contains the answer.** Code blocks, URLs, paths, and
filenames-with-extension are stripped, and a hard audit rejects any case where a
literal path or filename survives. See `bench/lib/query.mjs`.

**3. Two query conditions, because stripping is a trade-off.**

| condition | what it does | what it answers |
|---|---|---|
| `natural` | strips paths/filenames/code only | how a real developer's question performs |
| `stemblind` | additionally strips every filename-derived word | does the tool do anything *beyond* matching filenames? |

The gap between them is `filename-dependence` — reported directly. For a product
whose pitch is "a graph of your codebase", that gap is the claim under test.

> This design came out of validating on 20 cases. The first version stripped
> stems unconditionally and turned PR #6690 into *"refactor update use merged
> recently adding endpoint..."* for the target `tools/auth/patreon.go` — a query
> no retriever on earth could answer. Blanket-stripping conflates *"the text
> names the file"* (real leakage) with *"the text mentions the concept the file
> is named after"* (just… the question). Both conditions are now reported.

## The retrievers

| name | what it is | why it's here |
|---|---|---|
| `graft` | `graft build` + `graft ask --json` | the tool under test |
| `bm25` | BM25 over raw file contents, **no graph, no index** | **the baseline that matters** — if the graph can't beat a search box, it isn't earning its keep |
| `gitgrep` | `git grep` on query keywords, ranked by distinct-keyword hits | the naive floor |

`bm25` tokenizes with camelCase splitting, i.e. deliberately generous to the
baseline, so the comparison is not rigged toward the conclusion we happened to
suspect.

### Fairness notes (both found by validating, both material)

- **`graft ask` ranks symbols, not files.** Several symbols share one file, so
  `-n 10` yielded only ~4.35 unique files where the file-ranking baselines got a
  full 5. The runner now over-requests symbols and cuts at *k unique files*, so
  every retriever is judged on the same number of candidates. This raised graft's
  R@10 from 47.5% → 57.5%.
- **Build time is never charged to query time.** A user builds once and queries
  many times. It is measured and reported separately.
- **Pack cost is measured on emitted text only** — never against a hypothetical
  "you would have read these files whole", which is the move that makes graft's
  own savings counter unfalsifiable.

## Case admission

Strict on purpose — a benchmark's credibility is decided by what it refuses to
measure. A PR is admitted only if it is merged, its merge commit resolves
locally, it touches 1–10 source files of the target language, it isn't a
dependency bump / release chore / docs-only change, its natural query keeps ≥8
content words, and the leak audit comes back empty. Gold files that don't yet
exist at the base commit are dropped (retrieval can't surface what isn't there);
a case with no remaining gold is excluded rather than counted as a universal miss.

Rejection counts are written into `data/cases/<repo>.json` so the filtering is
auditable, not just asserted.

## Limits — read before quoting any number

- **This measures retrieval, not correctness and not cost savings.** It is a
  cheap, deterministic proxy. It cannot tell you "tool X saves 32%".
- **n=20 per repo is a method validation, not a verdict.** Confidence intervals
  at that size overlap heavily. 50+ cases across 4 repos is the real run.
- `git grep` substitutes for ripgrep (not installed here); same class of tool,
  and it makes the harness reproducible anywhere git exists. Swap it in
  `bench/retrievers/gitgrep.mjs`.

## Layout

```
bench/fetch-prs.mjs        GitHub → data/cases/<repo>.json
bench/run.mjs              the runner
bench/lib/query.mjs        query construction + contamination defense
bench/lib/metrics.mjs      recall@k, MRR, budget-constrained recall, Wilson CI
bench/retrievers/*.mjs     graft | bm25 | gitgrep
results/<repo>-k<K>-b<B>.json
```
