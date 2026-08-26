# graft-retrieval-bench

A deterministic, **$0**, reproducible retrieval benchmark for code-context tools.

Built because [@nanonets/graft](https://github.com/trailhq/Graft) (now `trailhq/Graft`) publishes strong
efficiency numbers, tells you to *"Reproduce with `npm run bench`"* on its website,
and ships **no `bench` script and no harness of any kind** — the string `bench`
does not appear anywhere in that repository.

This is that missing harness. No judge model, no API key, no LLM call.

```bash
npm install
node bench/fetch-prs.mjs --repo pocketbase --limit 50   # build the case set
node bench/run.mjs       --repo pocketbase --k 10       # score the retrievers
node bench/report.mjs                                   # pooled cross-repo table
```

## Results

**161 cases · 4 repos · 4 languages.** Natural condition (the query a developer
would actually type), k=10:

| retriever | R@1 | R@5 | R@10 | MRR | hit% | 95% CI | tok/query |
|---|---|---|---|---|---|---|---|
| `graft ask` | 13.6% | 37.3% | 46.7% | 0.295 | 55.3% | [48–63%] | 855 |
| **`bm25`** (no graph) | **25.1%** | **55.9%** | **67.3%** | **0.438** | **76.4%** | **[69–82%]** | **160** |
| `gitgrep` | 9.8% | 37.7% | 46.0% | 0.240 | 52.8% | [45–60%] | 155 |

```
paired graft − bm25 on R@10:  −20.6 pts
95% CI [−27.8, −13.3]   t = −5.56   n = 161   → significant at p<0.05
```

> **Corrected 2026-08-24.** An earlier version of this table reported n=186 and
> −18.0 pts. `data/cases/pocketbase.json` held 50 rows over 25 unique PRs, so
> half that set was counted twice in every mean. Caught by @Frankie-Xu on
> [trailhq/Graft#117](https://github.com/trailhq/Graft/issues/117). See
> [Corrections](#corrections).

It loses on every repo — including TypeScript, the language graft itself is
written in and lists as full-fidelity:

| repo | language | cases | graft | bm25 |
|---|---|---|---|---|
| pocketbase | Go | 25 | 56.0% | **65.2%** |
| django | Python | 50 | 52.0% | **61.0%** |
| spring-boot | Java | 49 | 51.0% | **76.0%** |
| nest | TypeScript | 37 | 27.7% | **65.7%** |

### The token claim, where it actually holds

`graft skeleton` is the one command whose savings claim survives scrutiny,
because the realistic alternative to "show me this file's API surface" *is*
reading the file. Measured over 325 files (`bench/skeleton-savings.mjs`):

| repo | reduction vs whole file | files ≥1000 tok |
|---|---|---|
| pocketbase | **−91.2%** | −92.5% |
| nest | **−81.5%** | −88.1% |
| django | **−76.5%** | −77.0% |

The saving **inverts on small files** — for 12% of nest files the skeleton costs
more than the source it summarises.

So: token reduction is real, but it comes from `skeleton`/`callers`/`map`, not
from `ask`, which costs 5.3× a no-graph baseline and finds 20.6 points less.

### Why it under-retrieves — two diagnoses, tested

Both explanations started as hunches from a single observation each. Tested over
the same 161 cases (`bench/verify-hypotheses.mjs`), one survived:

**Morphology — REFUTED.** A query for "atomically" failing to surface
`writeJsonAtomic` suggested missing stemming. Pre-expanding queries with stems
and camelCase splits does **not** help: 46.7% → 47.3% pooled (**+0.6 pts**), well
inside noise, and the sign disagrees across repos (pocketbase −2.8, nest −0.2,
django +1.4, spring-boot +2.0). Refuted as "this is the cause", not as "this
makes it worse" — an earlier version of this README said the recall *drops*,
which was an artefact of the duplicate rows.

**One hop — CONFIRMED.** Computed on graft's own `wiring.json`: for every gold
file `ask` missed, is it one edge (`imports`/`calls`/`extends`) from a file it
*did* return?

| repo | files | misses | captured at 1 hop | reach | lift vs chance |
|---|---|---|---|---|---|
| pocketbase | 298 | 39 | 51.3% | 21.5% | 2.4× |
| nest | 1,746 | 49 | 4.1% | 2.4% | 1.7× |
| django | 2,962 | 47 | 46.8% | 6.2% | 7.6× |
| spring-boot | 8,483 | 43 | 34.9% | 0.8% | **45.0×** |
| **pooled** | | **178** | **33.1%** | **6.1%** | **5.5×** |

The extractor builds the right edges; the ranker doesn't walk them.

**A 2-hop variant — DISCARDED.** It captured 64.1% of misses, which looked like
the headline until the chance level was computed: the 2-hop neighbourhood covers
~69% of pocketbase, i.e. *below* chance there and only 1.3× pooled. The
reach-vs-chance check is now part of the script — without it, a non-result would
have shipped as a finding.

Bounding the surviving one: the neighbourhood is 42–183 files in absolute terms,
so this is a **candidate-generation** signal, not a predicted ranking gain. And
it is weakest (1.7×) exactly where graft is weakest (nest), so it would not
explain the TypeScript case.

### Scope — please read before quoting this

- This judges **`graft ask`**, not `map` / `callers` / `skeleton` / the MCP
  server. "graft's search loses to BM25" is supported; "graft doesn't work" is
  not.
- It measures **retrieval**, not agent correctness and not end-to-end cost.
- It says nothing about graft's SWE-bench claims, which are a different
  experiment on a different axis.
- graft's engineering is not in question here: 622 tests pass, the tree-sitter
  tier is deterministic and fast, there is no telemetry, and the licence is MIT.

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

- **`graft ask` ranks symbols, not files.** Several symbols routinely share one
  file, so asking for `-n k` returns fewer than k distinct files — over the
  top-5 sampled, 4.35 unique files against a full 5 for the file-ranking
  baselines. The runner now over-requests symbols and cuts at *k unique files*,
  so every retriever is judged on the same number of candidates. On the 20-case
  validation set this raised graft's R@10 from 47.5% → 57.5%; the pooled 186-case
  figures already include the fix.
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
  at that size overlap heavily. The published run is 161 cases across 4 repos
  (pocketbase yields 25 after deduping — see [Corrections](#corrections)).
- `git grep` substitutes for ripgrep (not installed here); same class of tool,
  and it makes the harness reproducible anywhere git exists. Swap it in
  `bench/retrievers/gitgrep.mjs`.
- Measured against **`@nanonets/graft` 0.10.1**, default `graft build` — no
  `--deep`, no LSP enrichment. That project ships often (it is now `trailhq/Graft`
  and past 0.13.0); re-run before quoting these numbers against a later version.

## Corrections

Kept in the open, because a benchmark that hides its own errata has no standing
to audit anyone.

**2026-08-24 — duplicate PR rows (affects every published figure).**
`fetch-prs.mjs` concatenated API pages without deduplicating by PR number. With
`sort=updated` the ordering shifts between requests on an active repo, so the
same PR can appear on more than one page. pocketbase ended up with **50 rows over
25 unique PRs**; django, nest and spring-boot were unaffected. Reported by
@Frankie-Xu on [trailhq/Graft#117](https://github.com/trailhq/Graft/issues/117).

Fixed by deduping while paging *and* when admitting cases, plus a defensive
dedupe in `run.mjs` that reports any duplicates it drops.

| | published | corrected |
|---|---|---|
| n | 186 | 161 |
| graft R@10 | 48.5% | 46.7% |
| bm25 R@10 | 66.5% | 67.3% |
| paired gap | −18.0 pts | −20.6 pts |
| 95% CI | [−24.4, −11.5] | [−27.8, −13.3] |
| tok/query ratio | 5.5× | 5.3× |
| pocketbase R@10 | 58.0% | 56.0% |
| H2 one-hop | 36.7% | 33.1% |
| H2 chance | 7.8% | 6.1% |
| H2 lift | 4.7× | **5.5×** |
| H1 delta | −1.0 pts | **+0.6 pts** |

The conclusion strengthened — the gap widened and the lift rose — so the error
had been flattering the tool under test, not this harness. The one claim that
became **false** is H1's direction: query expansion does not make recall worse,
it does nothing.

## Layout

```
bench/fetch-prs.mjs        GitHub → data/cases/<repo>.json
bench/run.mjs              the runner
bench/lib/query.mjs        query construction + contamination defense
bench/lib/metrics.mjs      recall@k, MRR, budget-constrained recall, Wilson CI
bench/retrievers/*.mjs     graft | bm25 | gitgrep
bench/verify-hypotheses.mjs  why it under-retrieves (with a chance-level check)
bench/skeleton-savings.mjs   the token-reduction claim, measured
results/<repo>-k<K>-b<B>.json
results/ALL.json             pooled cross-repo summary
results/HYPOTHESES.json      the two diagnoses, verdicts included
```
