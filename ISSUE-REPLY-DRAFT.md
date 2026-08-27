@Frankie-Xu — you're right about the duplicate rows, and thank you for checking
the case file rather than taking the numbers on trust. Confirmed and fixed;
every published figure has moved.

## The bug

`fetch-prs.mjs` concatenated API pages without deduplicating by PR number. With
`sort=updated&direction=desc` on an active repo the ordering shifts between
requests, so the same PR can land on more than one page. pocketbase ended up
with 50 rows over 25 unique PRs. django, nest and spring-boot were unaffected,
which is why it went unnoticed.

Fixed at both ends (dedupe while paging, dedupe on admission) plus a defensive
dedupe in `run.mjs` that reports any duplicate rows it drops. pocketbase was
re-run at 25 unique PRs; the other three were re-aggregated.

## Corrected figures

| | published | corrected |
|---|---|---|
| n | 186 | **161** |
| graft R@10 | 48.5% | **46.7%** |
| bm25 R@10 | 66.5% | **67.3%** |
| paired gap | −18.0 pts | **−20.6 pts** (95% CI [−27.8, −13.3], t = −5.56) |
| tok/query ratio | 5.5× | **5.3×** |
| pocketbase R@10 | 58.0% | **56.0%** |
| H2 one-hop | 36.7% | **33.1%** |
| H2 chance | 7.8% | **6.1%** |
| H2 lift | 4.7× | **5.5×** |

The bug had been flattering `ask`, not this harness — the gap widened and the
lift rose. That is not a defence of the original numbers; they were wrong.

**One published claim became false**, and I'd rather say so plainly than let it
sit in the thread: I reported H1 (query expansion) as making recall *worse*,
−1.0 pts. Deduplicated it is **+0.6 pts** — noise, with the sign disagreeing
across repos (pocketbase −2.8, nest −0.2, django +1.4, spring-boot +2.0). Still
refuted as *the cause* of the gap, but it is not a regression, and #126's
negative expansion result is the stronger evidence on that question anyway.

Full errata: https://github.com/gersonsebastianx/graft-retrieval-bench#corrections

## On your re-run

Your pocketbase numbers on current main and mine on 0.10.1 line up: you get 38
misses at 57.9% one-hop, I get 39 at 51.3%. Same conclusion — #126 and #137 did
not absorb it.

Two things in your comment that I think are more important than my original
finding:

**The overfetch slice.** That 57.9% of misses already appear in `ask`'s unique-file
list below k=10 is a sharper result than mine, because it splits the problem: for
that majority, nothing needs to be *generated* — the candidate is already there
and ranked too low. That is a selection/weighting problem, not a candidate-set
problem, and it is cheaper to fix. Your 13–32% bound on "1-hop and not in the
overfetch window" is the part that actually needs new candidates. My write-up
framed the whole 33% as candidate generation; your decomposition is better.

**Declining to quote a lift.** Not quoting lift-vs-chance because the index grew
from ~283 to ~474 files was the right call — the denominator isn't comparable and
capture-of-missed-gold doesn't need it. Worth noting that on my corrected
pocketbase run the reach is 21.5% and the lift 2.4×, so pocketbase was always the
weakest of the four; the strong cases are django (7.6×) and spring-boot (45×),
neither of which is in #126's 122-case set.

## Offer

You said django and spring-boot haven't been re-run on current main. I can do
that — same harness, same `merge^1` graphs, unique-PR sets, before/after R@10
and one-hop-of-misses. That covers the two repos where the signal is strongest
and where #126's negative result doesn't apply. Say the word and I'll post the
numbers here; no PR from me, this is your slice.

On the proposal itself I don't think my opinion should carry weight — it's a
ranking change in your codebase and @anirudhkumar-nanonets should scope it. The
one thing I'd ask for as an outside measurer: whatever lands, please report
precision alongside recall. Naive expansion trading precision for recall would
be invisible in R@10 alone, and your step 6 already anticipates that.

One housekeeping note for anyone finding this later: the repo moved from
`nanonets/graft` to `trailhq/Graft` during this thread; old links redirect.
