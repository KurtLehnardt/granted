# R4b — Cost & Latency per Search (report + pricing recommendation)

**Author:** EVAL + COST worker (opus) · **Date:** 2026-09-08
**Status:** This report **summarizes and extends the existing measurement**, `docs/R4b-cost-findings.md`
(real run, 2026-08-15). **No new live cost measurement was taken this session** — by directive (don't
re-measure; the numbers are current) and by necessity (the app's Anthropic account is credit-exhausted;
see the golden-set review). Pricing rates were re-verified as still current (§2).

---

## 1. Headline (recommended for pricing decisions)

| Metric | Value | Source |
|---|---|---|
| **Cost per novel search (mean)** | **$0.224** | `docs/R4b-cost-findings.md`, n=5, 2026-08-15 |
| Cost per search — median / p90 | $0.229 / $0.236 | recomputed from the same 5 per-search figures |
| Cost per search — min / max | $0.210 / $0.236 | same |
| **Latency per search (mean, wall-clock)** | **99.2 s** | same |
| Latency — median / p90 | 99.7 s / 108.7 s | recomputed |
| Latency — min / max | 88.7 s / 108.7 s | same |
| **Cached / precomputed search (the 5 judged cases)** | **≈ $0.00, instant** | served from `data/precomputed.json`, no model call |

> **Recommended planning figure: budget ~$0.25 per novel search** as fully-loaded marginal COGS.
> That rounds the measured $0.224 mean up to absorb (a) run-to-run token variance on the dominant
> `candidate_analysis` stage and (b) the extra `weak_field_explanation` call on honest-no searches.
> It sits **~50% under** the §5.2 free-tier placeholder ceiling (`RunBudget.free.max_cost_usd = 0.50`,
> `lib/contracts/runBudget.ts`), leaving real headroom. The five judged demo cases cost **$0** (cache).

---

## 2. Pricing rates used (and re-verification)

Costs are computed by the app's own meter (`lib/metering/pricing.ts` → `priceUsage()`), keyed by the
exact model-id strings the call sites use. Rates re-verified current on 2026-09-08 against the
`claude-api` skill's model table (cached 2026-06-24):

| Model (id) | Where used | Input $/MTok | Output $/MTok | Status |
|---|---|---|---|---|
| Claude Sonnet 4.6 (`claude-sonnet-4-6`) | `candidate_analysis`, `weak_field_explanation` | $3.00 | $15.00 | **current ✓** |
| Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | `profile_extraction`, `candidate_prescore` (two-pass) | $1.00 | $5.00 | **current ✓** |
| text-embedding-3-small (OpenAI) | `query_embedding` | $0.02 | — (no output tokens) | current (OpenAI pricing page, per `pricing.ts` note) |

`pricing.ts` is stamped `PRICING_AS_OF = 2026-08-15`; both Anthropic rates still match today, so no
edit is needed. Every logged/attached cost summary carries this date (`SearchCostDebug.pricingAsOf`)
so a stale-price search is always traceable.

**Model routing note:** the pipeline already routes correctly per northstar §3 — the cheap Haiku 4.5
handles profile extraction (and the optional two-pass pre-score); the expensive Sonnet 4.6 is reserved
for the candidate analysis and the weak-field narrative; embeddings are OpenAI. The measured $0.224 is
therefore a realistic single-pass figure, and the two-pass path (`e3_two_pass`, default OFF) would move
more of `candidate_analysis` onto Haiku and cut it further.

---

## 3. Where the money and time go (from the 2026-08-15 run, averaged over 5 searches)

| Stage | Model | Avg cost | % of cost | Avg latency | % of latency |
|---|---|---|---|---|---|
| `candidate_analysis` (score+explain 24 candidates, 3 concurrent batches) | Sonnet 4.6 | $0.2102 | **94.0%** | 83.0 s | **83.6%** |
| `profile_extraction` | Haiku 4.5 | $0.0110 | 4.9% | 12.3 s | 12.4% |
| `weak_field_explanation` (only on honest-no searches) | Sonnet 4.6 | $0.0119 | +5.7% of that one search | 16.8 s | +16.4% of that search |
| `query_embedding` | text-embedding-3-small | $0.0000036 | ~0.002% | 0.57 s | 0.6% |

**`candidate_analysis` dominates both cost and latency** — it is the pipeline's floor (~83 s). The
model choice there is already correct (Sonnet for the reasoning-heavy step); the lever is the **call
shape** — 3 batches × 8 candidates × ~900 output tokens each. The two highest-value optimizations the
data points to (unchanged from the 2026-08-15 findings): **trim per-candidate output tokens** (does
every one of 24 scored candidates need the full 4-part narrative, or only those clearing a tier
threshold — which is exactly what `e3_two_pass` does) and **split the monolithic scorer prompt**. Not
model routing (already right) and not embeddings (already effectively free — five searches' combined
embedding cost was $0.000018).

---

## 4. Instrumentation (goal B) — status

**The per-search instrumentation R4b needs already exists and is fully wired** — no behavioral code
change was required:

- `lib/metering/meter.ts` — one `CostMeter` per `buildOpportunityMap()` call, threaded through every
  stage (incl. the weak-field early-exit). Per-stage token/cost/latency aggregation; **never throws**
  (defensive by construction, plus a belt-and-suspenders wrap in `match.ts`). Emits one structured
  `[cost] {…}` server log line per completed search **unconditionally**, and attaches the same
  `SearchCostDebug` breakdown to the response **only** when the `r4b_cost_debug` flag is on (cost
  figures never reach the end-user UI otherwise — CON-03).
- `lib/metering/pricing.ts` — the pure, dated price table + `priceUsage()` (unpriced model ⇒ `$0` +
  a warning, never a guessed rate).
- Call-site wiring: `lib/embed.ts` records `query_embedding`; `lib/claude.ts` records
  `profile_extraction` (Haiku), `candidate_analysis` (Sonnet, with `recordStageLatency()` overwriting
  the summed batch latency with the true concurrent wall-clock), `candidate_prescore` (Haiku, two-pass),
  and `weak_field_explanation` (Sonnet).

What this task **adds** is a measurement/aggregation harness, not instrumentation:

- `scripts/eval-run.mjs` — calls `buildOpportunityMap` directly with `r4b_cost_debug` **and**
  `discernment_layer` on, captures each search's full `costDebug` **and** its quality picture, and
  prints a **mean / median / p90** cost & latency aggregate across the run (methodology: sort, mean =
  arithmetic, median = middle/avg-of-two, p90 = nearest-rank `ceil(0.9·n)`). It hard-stops on any
  429/credit error so a dead account is never hammered. (Reuses the pattern of the existing
  `scripts/cost-measure.mjs`.)

**This session recorded zero live cost samples** — the harness's first live call returned the `400`
credit-exhausted error, so the numbers above remain the authoritative measurement. When credits are
restored, `node --import tsx scripts/eval-run.mjs` will emit an updated aggregate in the same shape.

---

## 5. Caveats

- n = 5, live non-deterministic model output — token counts (hence cost) vary run-to-run with
  candidate-set composition and response length. Treat the ranges as a real order-of-magnitude
  baseline, not a guarantee. Re-run after any change to the `candidate_analysis` prompt/batching.
- The measured search is the **novel** (uncached) path. The five judged demo cases are served from
  `data/precomputed.json` at ~$0 — so demo-day cost is negligible; only genuine founder traffic incurs
  the ~$0.22–0.25/search.
- Reproduce: `source ~/.zshrc && cd scaffold && npm run cost:measure` (existing 3-case harness) or
  `node --import tsx scripts/eval-run.mjs` (this task's 8-profile quality+cost harness). Both spend real
  credits.
