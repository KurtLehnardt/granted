# Granted: Go-to-Market Working Doc (`/ship`)

_Living artifact for the go-to-market effort. Tracks product context, decisions, expert insights, open questions, deliverables._

## Product context (Phase 1 discovery)

**What it is.** Granted turns a founder's plain-English company description into a map of real **federal funding opportunities** (grants, SBIR/STTR R&D, procurement, loans, assistance, scholarships), scored for fit, screened for eligibility, and (the differentiator) **calibrated to tell you honestly when *not* to apply.**

**The one thing that makes it different.** Every other "grant finder" is incentivized to show you *more* matches. Granted is built around the **honest no**: a weak or ineligible idea gets a clean *"we don't recommend applying"* and a redirect, not a wall of amber "maybe" cards. Nothing is fabricated. Every claim is grounded in a real award record or thrown out.

**Feature set.**
- Matching pipeline: profile extraction → 968-opportunity keyless corpus → fit scoring (0–100, program-officer criteria) → eligibility screen → **discernment layer** (recommend / verify / don't-apply + whole-map verdict).
- **Deep competitor & market analysis** (Max tier): real awarded-grant intelligence + live web competitors → cited positioning brief.
- **Application assist**: requirements → draft → forms → budget → package (grounded, gap-flagged). grants.gov S2S (mock). Chrome autofill extension.
- Progressive streaming; recommendation badges; questionnaire; Google auth.

**Target personas.**
1. **First-time technical founder** (SBIR/STTR-eligible R&D startup) who knows grants exist but is lost in grants.gov and afraid of wasting weeks on the wrong application.
2. **Small-business owner** exploring non-dilutive funding, unsure if they even qualify.
3. **Grant-curious solo founder** who needs an honest gut-check before investing time.

**Differentiation (1–2 key advantages).**
1. **The honest "don't apply."** Calibrated discernment that saves founders weeks, validated on a live golden set.
2. **Grounded, never fabricated.** Real federal award data + a schema that throws on invented claims. Trust as a feature.

**Tech stack.** Next.js 14 (App Router) · TypeScript · Tailwind · Vercel (Pro) · Supabase (auth) · Claude (Sonnet/Haiku) + OpenAI embeddings. Feature-flagged, six CI gates, 823 tests.

**Current state.** Live at `fund-finder-blush.vercel.app`. No real users yet. Mock billing with a Max tier concept. No landing page (the app *is* the entry), no free lead-gen tool, no SEO/AEO surface, no analytics-driven funnel.

## Decisions (from the user)

| Question | Decision |
|---|---|
| Budget | **Bootstrapped:** $0, self-built, organic only |
| Stage | **Live, pre-users:** focus on first 100 users + credibility |
| Deliverables | **Strategy + core assets:** GTM doc + landing page + free lead-gen tool, as PRs |
| Expert reviews | **Yes:** parallel UX architect + business exec critique |

## Expert insights (Phase 2)

Two parallel critiques ran (UX architect + business exec). **Both read the stale v1 working directory** (`aa3297f`, 476 grants-only) rather than the deployed v2 on `origin/main` (968 multi-source), so their *product-state* claims ("thin corpus", "0 SBIR", "blocking spinner") are partly outdated; their **strategy is app-state-independent and used in full**.

**High-confidence agreements (both):**
- **Ship a landing page.** A cold visitor currently hits a bare app; the honest-no belongs on the front door as proof + trust + funnel.
- **Ship a zero-friction, no-signup free tool:** the growth engine; capture email *after* the aha.
- **Keep the first search ungated + streamed.** Never a blank ~90s wait; sign-in is a post-result reward. (UX confirmed `/api/match` is not auth-gated in code, only Max is, so ungating is a config flip, not a rebuild.)

**Business exec adds:** outcome-first positioning (don't-waste-3-weeks) with the honest-no as proof; the real rival is *sycophantic ChatGPT that hallucinates programs* → win on grounded + non-sycophantic; Free / Max (~$49/mo or ~$149 per-app) + founding lifetime deal; channels = funding intermediaries › founder communities › grounded content/AEO; stamp data provenance/"as of" date (trust). Time-wasters pre-users: perfecting the mock Max tier, broad ingestion, SEO tooling, paid ads.

**UX architect adds:** the honest-no is invisible until the user does the work (put a real "don't apply" verdict on the landing page); `/demo` is a perfect zero-friction hook but **orphaned/unlinked** (surface it); intake asks too much too cold (progressive profiling); metadata is generic ("Government Opportunity Finder"; rebrand to "Granted", add OG/JSON-LD); minor a11y (chip touch targets <44px).

**Corrections carried into the build:** deployed corpus is **968 multi-source** (not 476); SBIR **is** covered (130 R&D); the match route **already streams** NDJSON; build runs off `origin/main` to avoid the stale-dir trap.

## Open questions (best-guess, don't block)

- **Pricing:** assume Free + a single "Max" tier (competitor/market analysis + application assist). Exact price TBD. The landing page can say "Free to start."
- **Domain:** currently the Vercel subdomain. A real domain (e.g. `granted.*`) strengthens AEO/SEO; noted as a fast follow.
- **Email capture backend:** the free tool should capture email, but there's no email store yet. Build the UI; stub the backend with a clear TODO (per `/ship` guidance).

## Deliverables summary

_Populated as PRs land (Phase 4–5)._
