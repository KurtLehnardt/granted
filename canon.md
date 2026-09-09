# canon.md — data-source map (recon)

The §4 Canon deliverable: what the product actually reads, coverage, refresh cadence, gaps.
Checked against `origin/main @ aa3297f`.

## Headline: the corpus is static, thin, and never refreshed
The running app reads a **local, pre-embedded corpus** (`scaffold/data/opportunities.json`) and
makes **no government-API call at request time**. That corpus was fetched **once, offline**, by
`scripts/1-fetch.mjs`, filtered to ~15 hardcoded keywords shaped around the 5 demo cases, and
**committed to git as static JSON**. There is **no scheduler, no refresh, and no freshness
check**. This was a deliberate demo choice (wifi-proof, instant) and is a correctness problem for
a real product:
- **Freshness (violates R8.3 / §4.4):** deadlines and open/closed status are frozen as of the
  fetch date. **A grant that has since closed will be shown as open.** The spec calls this a
  correctness bug, not a caching tradeoff.
- **Coverage:** grants.gov only, and only what ~15 keywords surfaced. A company outside those
  keyword lanes retrieves poorly; whole agencies and mechanisms are simply absent.
- **DECIDED (§4.3, owner, 2026-08-15): the hybrid.** Keep local semantic retrieval (it already
  works and is what makes latency reachable); add **scheduled ingestion** to broaden/refresh the
  store; add a **targeted live freshness check that hits the gov sites at display time on only
  the surfaced opportunities** (also an R4b line item). Querying live for the whole corpus per
  request was explicitly rejected — it reintroduces the latency R4b exists to kill and fails hard
  when a source is down (SBIR is 403 today). Source failure degrades visibly per §4.6. See
  `resolved-questions.md`.

## Current corpus contents (measured)
- `data/opportunities.json` — **476 opportunities, 100% `source: grants.gov`, all `kind: grant`**,
  each pre-embedded (OpenAI `text-embedding-3-small`, **512-dim**). 287/476 carry a deadline;
  140 are `forecasted`.
- `data/awards.json` — **335 opportunities** with attached SBIR award history (company/agency/
  amount/year/state), used for the "similar companies" panel and R5's free-tier count.
- `data/precomputed.json` — **5 frozen** OpportunityMaps (the judged cases); served instantly.

## Sources — status, coverage, cadence, gaps
| Source | Endpoint (offline, `scripts/1-fetch.mjs`) | Status | Feeds | Coverage / gap |
|---|---|---|---|---|
| **Grants.gov** | `api.grants.gov/v1/api/search2` + `fetchOpportunity` | ✅ working | the 476-opp corpus | Federal grant NOFOs, but only ~15 keyword lanes. No topic/eligibility detail beyond synopsis. |
| **SBIR.gov solicitations** | `api.www.sbir.gov/.../solicitations` | ❌ **403 (site maintenance)** | nothing | **0 open SBIR/STTR topics.** Cases 1/2/4 lean on SBIR; currently carried only via grants.gov SBIR programs + award history. |
| **SBIR.gov awards** | `data.www.sbir.gov/...award_data_no_abstract.csv` (bulk) | ✅ working | `awards.json` (history only) | Award *records*, not opportunities. Utah + keyword filtered. |
| **USAspending.gov** | `api.usaspending.gov/api/v2/search/spending_by_award` | ⚠️ **fetched but UNWIRED** | nothing | Query returns mega state block-grants, not startup awards; needs recipient/business-type redesign before it can feed R5. |
| **SAM.gov** (contracts + entity/UEI) | — | ❌ **not integrated** | — | Needed for R6 (S2S/registration) and R8 (registration/UEI gates, contract opportunities). |
| **Agency feeds** (NIH Guide/RePORTER, NSF, DOE, DoD DSIP) | — | ❌ **not integrated** | — | Where topic specifics + eligibility rules live (R8.4). Absent. |
| **State / local / foundation** | — | ❌ not integrated | — | Spec `[DECIDE §4.2]` recommends **out of scope** this phase; state it in the UI. |

## Eligibility rules (R8 / §4.5)
**Greenfield.** The only screening is `ruleGate` (`lib/match.ts:23-31`): an SBIR employee-count
cap and a "universities/governments only" regex. **No structured, per-program, cited eligibility
rules exist.** There is nowhere for R8's rules to live yet — the Canon must add a rules layer
(`EligibilityDetermination` / structured rules with citations, `model_inferred` until reviewed).

## Refresh & freshness (§4.4)
- **Refresh cadence: none.** One-time manual `npm run data:*`. Data age is not surfaced in the UI.
- **Freshness check: none.** No display-time status verification. Required for the actionable set.
- **Failed-sync alarm: n/a** (no sync exists to fail). Must be built with ingestion.

## Retrieval (§4.5)
Single-stage today: cosine over the embedded corpus, a coarse `ruleGate`, then LLM scoring. The
spec's multi-stage shape (hybrid keyword+semantic candidate-gen → **distinct eligibility stage**
→ rank/synthesize) is partially present (retrieval + a stub gate + ranking) but the eligibility
stage is a stub and there is no keyword arm.

## Storage & caching layers (where data lives)
Two storage concerns, deliberately separate (conflating them is a §5.3 bug):
- **User data (descriptions, runs, consent)** → **client-side localStorage pre-R9** (R9.0),
  because it's sensitive and we retain nothing server-side until real accounts. Moves to a
  server DB at R9. **Never holds corpus data.**
- **Gov corpus (opportunities, eligibility rules, award records)** → **server-side, shared,
  versioned store.** Public, identical across users, large, structured. **Never localStorage.**

**Corpus store — DECIDED: Supabase Postgres + pgvector** (owner wired the Supabase MCP,
`project_ref=YOUR_SUPABASE_REF`, 2026-08-15). Holds normalized `Opportunity` records +
embeddings + structured cited eligibility rules in one place; supports hybrid keyword+semantic
retrieval (§4.5) and snapshot versioning (R10.2); is the sink for the scheduled ingestion job.
The v1 static-JSON-in-repo + in-memory cosine is the degenerate version being replaced. See
`resolved-questions.md` V-E.

**Caches (all server-side):** per-source TTL cache on gov-API responses (cadence = publication
schedule); short TTL on the live freshness re-check; Anthropic prompt caching for stable
system+canon text; per-user **collision-safe** cache on profile extraction / repeat searches.

## What this means for ship order
- **Slice 1 (Contracts + Canon) is correctly first and is heavier than the spec assumed for
  §4.2** (expand+refresh a thin static corpus) but **lighter for retrieval plumbing** (local
  retrieval already exists).
- **R8 depends entirely on new Canon rules** — it cannot start until the rules layer + citations
  exist.
- **The §4.3 hybrid decision blocks the shape of most downstream Canon/R4b/R8 work** and should
  be settled at the review checkpoint (see `open-questions.md`).
