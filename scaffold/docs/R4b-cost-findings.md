# R4b — cost-per-search measurement findings (2026-08-15)

Real measurement, not an estimate. Ran `npm run cost:measure` (`scripts/cost-measure.mjs`) against
5 novel company descriptions — distinct from both the demo-day precomputed set
(`scripts/4-precompute.mjs` / `scripts/dev-calibrate.mjs`) and the script's own baked-in defaults —
calling `buildOpportunityMap` directly (no dev server, no cache short-circuit), against the live
Anthropic and OpenAI APIs. Pricing per `lib/metering/pricing.ts` (`claude-sonnet-4-6` $3/$15 per
MTok in/out; `text-embedding-3-small` $0.02/MTok in, no output cost), retrieved and verified
2026-08-15. Raw per-search JSON: `/tmp/r4b-cost-results.json` (not committed — ephemeral, tied to
this one measurement run).

**Total spend for this run: $1.118 across 5 real searches** (user-authorized, per the R4b task).

## Headline numbers (n=5)

| Metric | Value |
|---|---|
| Average cost / search | **$0.2236** |
| Min / max cost | $0.2100 – $0.2361 |
| Average latency / search (wall-clock) | **99.2s** |
| Min / max latency | 88.7s – 108.7s |

## Per-search results

| Case | Path | Strong matches | Total cost | Total latency |
|---|---|---|---|---|
| Robotics (Michigan, welding-arm hardware) | normal | 4 | $0.2286 | 99.7s |
| Digital health (NC, AI clinical docs) | normal | 3 | $0.2361 | 96.7s |
| Coffee subscription box (Oregon, consumer) | **weak-field** | 0 | $0.2100 | 102.2s |
| Zero-trust network security (VA, critical infra) | normal | 1 | $0.2112 | 88.7s |
| Low-carbon cement additive (OH, materials) | normal | 4 | $0.2319 | 108.7s |

The coffee-subscription case was included deliberately (mirrors the original demo set's case-5
role) to exercise the "honest no" path — it correctly produced zero strong matches and triggered
`explainWeakField`, confirming the weak-field branch is captured by the meter too, not just the
happy path.

## Where the money and time go (stage breakdown, averaged across the 5 searches)

| Stage | Avg cost | % of total cost | Avg latency | % of total latency |
|---|---|---|---|---|
| `candidate_analysis` (explainMatches, 3 concurrent batches scoring 24 candidates) | $0.2102 | **94.0%** | 83.0s | **83.6%** |
| `profile_extraction` (extractProfile) | $0.0110 | 4.9% | 12.3s | 12.4% |
| `weak_field_explanation` (explainWeakField, only ran once — case 3) | $0.0119 | 5.7% of that search | 16.8s | 16.4% of that search |
| `query_embedding` (OpenAI, text-embedding-3-small) | $0.0000036 | ~0.002% | 0.57s | 0.6% |

**`candidate_analysis` is the dominant cost AND latency driver, by a wide margin.** This is exactly
where `lib/contracts/modelRouting.ts` already routes to the expensive model (`candidate_analysis`
→ `claude-sonnet-4-6`), so the model choice itself isn't the waste — the call shape is: 3 batches ×
8 candidates × ~900 output tokens/candidate, run concurrently via `Promise.allSettled` (already
parallelized, per the code comment in `lib/claude.ts`). The ~83s this stage takes is essentially
the pipeline's latency floor today.

`query_embedding` is priced so far below the other three stages it is real-world negligible — five
searches' combined embedding cost was **$0.000018**, three orders of magnitude below one
`profile_extraction` call.

## Context for R4b's next steps

- **§5.2's free-tier placeholder ceiling (`RunBudget.free.max_cost_usd = 0.5`,
  `lib/contracts/runBudget.ts`) has real headroom**: measured average cost ($0.224) is about 45% of
  that placeholder. This is informational only — this task does not change `RunBudget`'s numbers,
  it just gives whoever calibrates them a real baseline to calibrate against.
- Per R4b's "work the waterfall" candidate list (`prompts/fundfinder-orchestrator-prompt.md`
  §R4b), the numbers above point squarely at `candidate_analysis`'s call shape as the highest-value
  target for both cost and latency: "trim tokens" (each candidate assessment runs ~900-1000 output
  tokens; is the full 4-part explanation needed for every one of the 24 scored candidates, or only
  for the ones that clear a tier threshold?) and "split the monolithic prompt" are the two
  candidates this data most directly supports investigating next — NOT model routing (already
  correct) and NOT embeddings (already free).
- This was a 5-search sample against live, non-deterministic model output — token counts (and so
  cost) vary run-to-run with candidate-set composition and response length. Treat the ranges above
  as a real order-of-magnitude baseline, not a guarantee; re-run `npm run cost:measure` after any
  change to `candidate_analysis`'s prompt or batching to confirm a delta.

## How to reproduce

```
# Ensure ANTHROPIC_API_KEY + OPENAI_API_KEY are set (export them in your shell,
# or put them in scaffold/.env.local)
cd scaffold
npm run cost:measure                          # 3 built-in novel cases
npm run cost:measure -- "description 1" "description 2"   # custom cases
```

Spends real API credits — see `scripts/cost-measure.mjs`'s header comment.
