@Frankie-Xu — whether this is the right slice is @anirudhkumar-nanonets' call, not mine. But your decomposition is the better framing and I ran it on all four repos, and it says three things about the proposal as written.

| repo | misses | 1 hop | already generated | needs new candidates | neither | lift |
|---|---|---|---|---|---|---|
| pocketbase | 39 | 51.3% | 25.6% | 28.2% | 46.2% | 2.4× |
| nest | 37 | 8.1% | 0.0% | 8.1% | 91.9% | 2.8× |
| django | 33 | 42.4% | 39.4% | 21.2% | 39.4% | 10.0× |
| spring-boot | 40 | 32.5% | 15.0% | 22.5% | 62.5% | **44.5×** |
| **pooled** | **149** | **33.6%** | **19.5%** | **20.1%** | **60.4%** | **5.9×** |

**Step 1 addresses about half the misses.** Admitting new neighbours serves the 20.1% that are one hop away and outside the overfetch window. The other 19.5% are already generated and merely ranked below k — expansion doesn't reach those, re-ranking does. My original write-up lumped both together and overstated what expansion could recover.

**Step 3 has an interaction worth a test.** Dropping expansion hits first protects the prefix, but 29 of those 149 misses already sit in the `-n` tail. If a neighbour outscores them they get pushed out of the visible range — so expansion could help the 20.1% and cost part of the 19.5%. Net unknown without a prototype, which is exactly why step 6 matters. A fixture where the gold file is *already in the tail* would catch it.

**Step 6's validation set is the weakest one for this.** pocketbase has the smallest lift of the four (2.4×); django and spring-boot are where the mechanism should show (10.0× and 44.5×), and neither is in #126's 122-case set. nest is worth adding as a negative control — 8.1% one hop, zero in the tail — if expansion moves nest, something is off.

And the ask you already anticipated in step 6: report precision next to recall. Expansion trading precision for recall is invisible in R@10.

## If you extend the harness

You ran against my `pocketbase.json`, which is fine. nest and django are not: queries are capped at 60 content words and **51.9% of every nest query was NestJS PR-template text** ("commit message follows guidelines", "Tests changes added", "Bugfix Feature Code style…"), 26.5% for django. The template was eating the query budget. Now stripped per repo — any token appearing in ≥50% of that repo's PR texts.

That plus your duplicate-rows catch moved every figure I published: n 186 → 155, gap −18.0 → −16.7 pts, and nest 27.7% → 48.0%, which retires the "worst in TypeScript" line from my original comment — the corrected spread is 9–20 points across all four languages, no outlier. Full errata: https://github.com/gersonsebastianx/graft-retrieval-bench#corrections

Your 57.9% tail on pocketbase vs my 25.6% is not comparable across those changes and the version gap, but if you think it's something else I'd want to know.
