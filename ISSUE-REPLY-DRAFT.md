@Frankie-Xu — I reproduced your pocketbase re-run exactly (38 misses, 22 one hop, 22 in tail), then ran your decomposition on both versions across all four repos. Identical cases, queries and scoring; only the `graft` binary differs. Your 13–32% bound resolves to 18.4% on pocketbase.

Pooled, 155 cases:

| | 0.10.1 | 0.13.0 |
|---|---|---|
| already generated, ranked below k | 19.5% | 43.2% |
| 1 hop, not in the tail | 20.1% | 19.2% |
| neither | 60.4% | 37.7% |
| R@10 | 55.0% | 56.5% |

Per repo, the bucket your proposal targets: pocketbase 28.2 → 18.4, nest 8.1 → 19.4, django 21.2 → 15.2, spring-boot 22.5 → 22.7. Noisy in both directions, flat in aggregate.

Two things I'd read off this, neither of which is the scoping call:

**#126 and #137 drained "neither" into "already generated" and left your bucket where it was.** 60.4 → 37.7 and 19.5 → 43.2, while 20.1 → 19.2. Gold that used to be absent from the candidate set is now present and ranked below the cut. Whatever expansion is worth, it's the one residual two rounds of work didn't move.

**The selection bucket is now the larger one and nothing in flight addresses it.** 43.2% of misses are in `ask`'s own output past k. #137 is file-first selection within the prefix, not a re-rank of the tail. Might be worth its own issue rather than being folded into this slice.

On step 3: dropping expansion hits first protects "the original prefix" — if that's the top-k rather than the whole `-n` list, a neighbour outscoring a tail entry evicts exactly the 43.2%. A fixture whose gold file is already in the tail would catch it.

## If you extend the harness

`pocketbase.json` is clean. nest and django are not: queries cap at 60 content words, and 51.9% of every nest query was NestJS PR-template text ("commit message follows guidelines", "Tests changes added", "Bugfix Feature Code style…"), 26.5% for django. Now stripped per repo — any token in ≥50% of that repo's PR texts.

That plus your duplicate-rows catch moved every figure I published: n 186 → 155, gap −18.0 → −16.7 pts, nest 27.7% → 48.0%. The "worst in TypeScript" line from my original comment doesn't survive it; corrected spread is 9–20 points across all four languages. Errata: https://github.com/gersonsebastianx/graft-retrieval-bench#corrections

`--graft-bin` is in the harness, so the before/after above is one command per repo against a prototype.
