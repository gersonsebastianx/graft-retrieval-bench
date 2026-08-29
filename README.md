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

**155 cases · 4 repos · 4 languages.** Natural condition (the query a developer
would actually type), k=10:

| retriever | R@1 | R@5 | R@10 | MRR | hit% | 95% CI | tok/query |
|---|---|---|---|---|---|---|---|
| `graft ask` | 24.9% | 45.3% | 55.0% | 0.421 | 63.9% | [56–71%] | 895 |
| **`bm25`** (no graph) | **34.0%** | **64.3%** | **71.7%** | **0.546** | **81.3%** | **[74–87%]** | **158** |
| `gitgrep` | 9.6% | 37.5% | 49.8% | 0.269 | 58.1% | [50–66%] | 152 |

```
paired graft − bm25 on R@10:  −16.7 pts
95% CI [−24.0, −9.4]   t = −4.49   n = 155   → significant at p<0.05
```

> **These numbers have been corrected twice.** v1 (n=186) double-counted half of
> pocketbase; v2 (n=161) still fed PR-template boilerplate into every query. Both
> corrections and their effects are in [Corrections](#corrections). The direction
> held across all three versions; the magnitude moved in both directions.

It loses on every repo — including TypeScript, the language graft itself is
written in and lists as full-fidelity:

| repo | language | cases | graft | bm25 | gap |
|---|---|---|---|---|---|
| pocketbase | Go | 25 | 56.0% | **65.2%** | 9.2 |
| django | Python | 49 | 59.7% | **76.8%** | 17.0 |
| spring-boot | Java | 45 | 54.8% | **72.5%** | 17.8 |
| nest | TypeScript | 36 | 48.0% | **68.1%** | 20.1 |

The gap is consistent at 9–20 points. An earlier version showed nest at a 38-point
outlier and led with *"worst in TypeScript, the language graft is written in"* —
that was **half an artefact of PR-template boilerplate** filling the query budget.
See [Corrections](#corrections).

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
from `ask`, which costs 5.7× a no-graph baseline and finds 16.7 points less.

### Why it under-retrieves — two diagnoses, tested

Both explanations started as hunches from a single observation each. Tested over
the same 155 cases (`bench/verify-hypotheses.mjs`), one survived:

**Morphology — REFUTED, and the right way to say it is "no effect".** A query for
"atomically" failing to surface `writeJsonAtomic` suggested missing stemming.
Across three data versions the pooled delta came out −1.0, then +0.6, then −1.4
pts — which is the tell. Looking per case instead of at the mean: pre-expanding
the query **leaves the top-10 completely unchanged in 137 of 155 cases (88%)**.
The deltas were noise from the ~18 cases that move at all. Expansion does not
help and does not hurt; it barely perturbs the ranking.

**One hop — CONFIRMED.** Computed on graft's own `wiring.json`: for every gold
file `ask` missed, is it one edge (`imports`/`calls`/`extends`) from a file it
*did* return?

| repo | misses | 1 hop | already generated | needs new candidates | neither | lift |
|---|---|---|---|---|---|---|
| pocketbase | 39 | 51.3% | 25.6% | 28.2% | 46.2% | 2.4× |
| nest | 37 | 8.1% | 0.0% | 8.1% | 91.9% | 2.8× |
| django | 33 | 42.4% | 39.4% | 21.2% | 39.4% | 10.0× |
| spring-boot | 40 | 32.5% | 15.0% | 22.5% | 62.5% | **44.5×** |
| **pooled** | **149** | **33.6%** | **19.5%** | **20.1%** | **60.4%** | **5.9×** |

The extractor builds the right edges; the ranker doesn't walk them.

**The pooled 33.6% describes no repo in particular.** Per-repo capture spans
8.1% (nest) to 51.3% (pocketbase), and pocketbase alone supplies 20 of the 50
captures. Every repo clears its own chance level, so the direction is
consistent — but quote the per-repo row, not the aggregate. (Raised in
`STATS-REVISION.md` against the v1 data, where the skew was worse: pocketbase
then carried 40 of 79 captures, partly because its rows were duplicated.)

The three middle columns are @Frankie-Xu's decomposition
([trailhq/Graft#117](https://github.com/trailhq/Graft/issues/117)), extended here
from pocketbase to all four repos. It splits the finding in half: **19.5% of
misses were already generated and merely ranked below k** — a selection problem,
cheaper to fix — while **20.1% are one hop away and absent from the overfetch
window**, the only part that genuinely needs new candidates. The original
write-up lumped both together and so overstated how much expansion could
recover.

**A 2-hop variant — DISCARDED.** It captured ~64% of misses, which looked like
the headline until the chance level was computed: the 2-hop neighbourhood covers
~69% of pocketbase, i.e. *below* chance there and only 1.3× pooled. The
reach-vs-chance check is now part of the script — without it, a non-result would
have shipped as a finding.

Bounding the surviving one: the neighbourhood is tens to low hundreds of files in
absolute terms, so "the answer is in there" is not the same as "expansion
improves ranking" — pulling neighbours in also pulls in wrong files, and naive
expansion can cost precision. And it is weakest on nest (8.1% capture), where
60–90% of misses are neither one hop away nor in the overfetch window, so
whatever is happening in TypeScript is a different problem.

### Across graft versions (0.10.1 → 0.13.0)

`--graft-bin` runs the same cases, queries and scoring against a different
release. Doing that reproduces @Frankie-Xu's independent pocketbase re-run
exactly — 38 misses, 22 one hop, 22 in tail — and resolves the 13–32% bound they
could only estimate from marginals to **18.4%** on pocketbase, 19.2% pooled.

| | 0.10.1 | 0.13.0 |
|---|---|---|
| already generated, ranked below k | 19.5% | **43.2%** |
| 1 hop, not in the tail | 20.1% | **19.2%** |
| neither | 60.4% | **37.7%** |
| R@10 | 55.0% | 56.5% |

Between those releases (PRs #126 and #137) gold moved out of "never generated"
and into "generated but ranked below the cut", while the bucket that would need
new candidates stayed where it was — noisy per repo (pocketbase 28.2 → 18.4,
nest 8.1 → 19.4, django 21.2 → 15.2, spring-boot 22.5 → 22.7), flat in
aggregate. R@10 barely moved either way.

Read that as two distinct residuals rather than one: candidate generation, and
selection over candidates already returned past `k`. Which is worth doing is a
question for that project's maintainers, not this harness.

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
  at that size overlap heavily. The published run is 155 cases across 4 repos
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

**2026-08-27 — PR-template boilerplate was eating the query budget (v2 → v3).**
Queries are capped at 60 content words. In repos with a PR template, that budget
was being spent on the checklist: **51.9% of every nest query** was NestJS
template text ("commit message follows guidelines", "Tests changes added",
"Bugfix Feature Code style update formatting…"), and 26.5% of django's.
pocketbase and spring-boot were unaffected, which is why it hid.

Fixed by stripping, per repo, any token appearing in ≥50% of that repo's PR
texts — a mechanical definition (a word in half the PRs cannot discriminate
between them) rather than a hand-written stop list, applied equally to every
retriever, with the stripped set written into each case file.

It was hurting `graft` roughly twice as much as `bm25`:

| | v2 (n=161) | v3 (n=155) |
|---|---|---|
| graft R@10 | 46.7% | **55.0%** |
| bm25 R@10 | 67.3% | **71.7%** |
| paired gap | −20.6 pts | **−16.7 pts** |
| tok/query ratio | 5.3× | 5.7× |
| **nest** graft R@10 | **27.7%** | **48.0%** |
| **nest** gap | **38.0 pts** | **20.1 pts** |

The nest row is the one that matters: the original write-up's most-quoted line —
*"the worst result is in TypeScript, the language graft is written in"* — was
about half artefact. The corrected picture is a consistent 9–20 point gap across
all four languages, with no outlier.

Also fixed here: `verify-hypotheses.mjs` only printed its results to a log, and
one overnight run's output was lost to `/tmp` cleanup; it now writes
`results/hypotheses-<repo>.json`. And that same run silently dropped 8 of 45
spring-boot cases to transient failures while reporting the degraded set as
complete — the script now prints what it dropped and warns above 10%.

**2026-08-24 — duplicate PR rows (v1 → v2).**
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
