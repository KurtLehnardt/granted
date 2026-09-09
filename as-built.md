# as-built.md — fundFinder current system (recon)

Recon target: `origin/main` @ `aa3297f` (the v1 buildout, merged + deployed). **Note:** the
local `main` checkout was stale at the original scaffold (`ff4a6ec`); it was fast-forwarded
to `origin/main` for this recon. The spec's `[HYPOTHESIS]` markers were largely inferred
from the *original* scaffold / deployed symptoms and do not match the current code — see
`hypothesis-check.md`.

The deployment URL is configurable via `NEXT_PUBLIC_SITE_URL` (defaults to
`http://localhost:3000` for local dev); set it to your own deployment's URL.

## Stack (verified, not assumed)
- **Next.js 14.2.15, App Router, TypeScript, React 18.** Tailwind 3.4. `@anthropic-ai/sdk`.
- Deployed on Vercel; **Vercel Root Directory = `scaffold/`** (the app lives in `scaffold/`,
  not repo root). Env keys `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` set in Vercel.
- No test framework, no CI, no lint rule config beyond tsconfig.

## Entry flow
1. `app/page.tsx` (client) — single screen: header + `IntakeForm` + conditional `OpportunityMap`.
   State is one `useState<OpportunityMap | null>`. No routing, no global state.
2. `components/IntakeForm.tsx` — textarea + "Find opportunities" CTA + a **row of 5 test-case
   chips** ("or try a test case") directly under the input. Clicking a chip **overwrites the
   textarea and immediately runs, with no confirm** — this is exactly the R7.1 affordance defect.
   Loading state is a **static label** ("Reading the federal register…"), no real progress (R4).
3. POST `/api/match` with `{ description }`.

## Request path — `app/api/match/route.ts`
- **Cache first:** exact-match lookup in `data/precomputed.json` keyed on
  `description.trim().slice(0,120)`. The 5 judged cases hit this → **instant, zero LLM/API cost.**
- **Cache miss → `buildOpportunityMap(description)`** in `lib/match.ts` (the live path).
- Only server-side logging: `console.error("match failed:", err)` on failure. **No description
  is explicitly logged or persisted server-side.** (Caveat: descriptions are sent to OpenAI +
  Anthropic in prompts → provider retention applies; and Vercel platform request logs exist.
  See `hypothesis-check.md` / R9.0 note.)
- `maxDuration = 60` (Vercel function cap). Returns `NextResponse.json` — **not a stream** (R4).

## Pipeline call graph — `lib/match.ts` `buildOpportunityMap()`
| # | Step | Impl | Model / API | Serial/Concurrent | Blocks |
|---|---|---|---|---|---|
| 1 | Extract profile + followUps | `extractProfile` (`lib/claude.ts:22`) | **claude-sonnet-4-6**, max_tokens 1500 | serial (first) | everything |
| 2 | Embed query vector | `embed` (`lib/embed.ts:9`) | **OpenAI text-embedding-3-small, dims 512** | serial (after 1) | retrieval |
| 3 | Rule gate + cosine retrieval | in-memory over `data/opportunities.json` | **none (local)** | local | candidates |
| 4 | Score + explain candidates | `explainMatches` (`lib/claude.ts:64`) | **claude-sonnet-4-6**, max_tokens 8000/batch | **concurrent** — `Promise.allSettled` over batches of 8 (v1) | ranking |
| 5 | Attach award history | `historyFor` (`lib/match.ts:40`) | **none** (`data/awards.json` lookup) | local | — |
| 6 | Weak-field explanation | `explainWeakField` (`lib/claude.ts:131`) | **claude-sonnet-4-6**, max_tokens 1200 | serial, **conditional** (only if strong < threshold) | final |

**Every LLM call uses the same model, `claude-sonnet-4-6`** — no cheap/analysis routing (H2).
The only live external API on the request path is the OpenAI embedding in step 2. **No
government API is called at request time.**

### Calibration constants (`lib/match.ts` `CALIBRATION`, v1-tuned)
`candidateFloor 0.22 · candidateCount 24 · scoreFloor 30 · weakFieldThreshold 1`.
Tier is derived from score (`tierFromScore`) for summary/card consistency. Verified behavior:
cases 1–4 return real matches with correct agencies; case 5 (marketplace) returns an honest
weak-field finding. `ruleGate` is the only eligibility logic: SBIR employee-count cap + a
"universities/govs only" regex. No structured, cited eligibility rules (R8 is greenfield).

## Output schema — `lib/types.ts` `OpportunityMap`
`{ profile, followUps[], summary{highPotential, fundingIdentified, agencies, closingIn90Days},
matches[Match], weakFieldFinding?{headline,reasoning,redirects[]}, agencyIntelligence[] }`.
`Match = { opportunity, tier(likely|verify|adjacent|none), score, criteria[], whyFit,
whyIneligible, whatToVerify, whatToDoNext, history? }`. **This is R3 of §3's `OpportunityMap`
contract, un-versioned.** Note `followUps` (clarifying questions) are produced *with the result*
— i.e. after the expensive pass — which is the exact sequencing R1 inverts.

## Auth / persistence / state
- **None.** `app/layout.tsx` wraps only fonts — no `AuthProvider`, no context. No `localStorage`,
  no database, no cookies, no session. R9.0 (mock auth + local persistence) is greenfield.
- Client state is ephemeral React `useState`; a completed run is unrecoverable on reload (R9.2).

## Latency (measured in v1)
- Novel input ≈ **98s** end-to-end (v1 parallelized `explainMatches`; was ~180s). The dominant
  cost is the serial `extractProfile` then the batched `explainMatches` generation.
- The 5 precomputed cases are **instant** (cache). No streaming, no partial results, no cancel.

## Design system
- Custom Tailwind tokens (`ink/paper/federal/rule/fit-likely/fit-verify/...`), fonts Bricolage
  Grotesque / Inter / IBM Plex Mono. **Not USWDS.** R7's 60/30/10 USWDS system is a new build,
  not a retune. No design-token contract, hard-coded hex in components.

## Offline data pipeline (not on request path) — `scaffold/scripts/`
`1-fetch.mjs` (gov APIs → `data/raw/`) → `2-normalize.mjs` (→ `data/opportunities.json` +
`data/awards.json`) → `3-embed.mjs` (OpenAI embeddings, 512-dim) → `4-precompute.mjs` (freezes
the 5 cases → `data/precomputed.json`). **Run manually once; output committed as static JSON.**
No scheduler, no refresh. See `canon.md` for source coverage and gaps.

## Immediate implications for the buildout (detail in hypothesis-check.md)
- The corpus is **already local and off the request path** — R4b's biggest proposed win
  ("move corpus retrieval off the request path") is already done; the remaining latency is LLM.
- The real R4b levers here are **model routing** (H2 confirmed) and **streaming** (absent), not
  parallelizing nonexistent live grant-API queries (H1 refuted).
- R8 (eligibility) and the Canon's structured cited rules, refresh, and freshness are **entirely
  greenfield** — `ruleGate` is a stub and the corpus never refreshes.
