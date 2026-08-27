# Granted: Go-to-Market Strategy

_Phase 3 of `/ship`. Bootstrapped · live pre-users · organic-only. Synthesizes two expert critiques (UX architect + business exec), corrected for the fact that both read the stale v1 working directory. The deployed product on `origin/main` is the full v2 (968-opportunity multi-source corpus, discernment layer, streaming, competitor analysis)._

## Positioning

**One line (outcome-first, differentiator as proof):**

> **Know whether a federal grant is actually worth chasing — before you burn three weeks writing one you can't win.**
> Granted maps your company to real federal funding, grounded in actual award data, and it's honest enough to tell you *"don't apply."*

- **Lead with the outcome** (don't waste three weeks), not the feature ("honest no").
- **The honest "don't apply" is the proof mechanism + trust wedge**, not the headline.
- **Sharpest competitive framing:** the real alternative is pasting your pitch into ChatGPT, which is *sycophantic* and *hallucinates programs that don't exist*. Granted is **grounded** (real corpus, throws on invented claims) and **non-sycophantic** (calibrated to say no). That contrast is the whole story.

## The eight distribution strategies, ranked for Granted

| # | Strategy | Priority | Why (for this product/stage) |
|---|---|---|---|
| 1 | **Free lead-gen tool** | 🟢 **Now** | Zero-friction "Grant Readiness Score": instant, shareable, embodies the brand, feeds email capture. The growth engine. |
| 2 | **Landing page** (the "8th": distribution > code) | 🟢 **Now** | A cold visitor currently hits a bare app. The honest-no hero is the differentiator + trust + funnel in one screen. |
| 3 | **Buy-the-audience → but *organic* intermediaries** | 🟢 **Now** | $0 version: partner with funding intermediaries (TTOs, SBDCs, APEX Accelerators, EDOs, accelerators) who are chartered to hand founders a free funding tool. Their reach puts the tool in front of exact-ICP founders. |
| 4 | **Grounded content + AEO** | 🟡 **Weeks 3–8** | Award-data teardowns + eligibility explainers. Compounding; uses the data moat; gets cited when founders ask an AI "am I SBIR-eligible?" |
| 5 | **Programmatic SEO** | 🟡 **Weeks 4–10** | "Should you apply to [program]?" / "who wins [agency] grants in [vertical]" pages off the corpus. Start with 3–5 quality pages. |
| 6 | **Viral artifact** | 🟡 **After engagement data** | Shareable "readiness grade" / honest-verdict cards. Premature until the free tool has usage. |
| 7 | **MCP server** | 🔵 **Later** | Expose "check federal funding fit" as a tool AI assistants call. Strong for the AEO thesis, but build after users. |
| 8 | **One pillar → seven channels** | 🔵 **Later** | Repurpose the retrospective / award teardowns across formats once there's a content cadence. |

## Detailed plans (the "Now" three)

### 1. Free tool: "Grant Readiness Score"
- **Zero friction:** no signup, instant, client-side. One screen.
- **Scores across the dimensions the app actually screens on:** entity formed · SAM.gov registration Active · UEI · US-based small business · genuine R&D / innovation component · commercialization path · funding-amount fit. Each maps to a real eligibility/fit criterion.
- **Output:** a 0–100 readiness grade + a per-dimension breakdown (✓ / ⚠ / ✗) + the single highest-impact fix + **an honest verdict banner** (e.g. *"You're not registration-ready yet. Fixing SAM.gov first will save you a rejection"*).
- **Email capture *after* the grade** ("Get your full opportunity map →"). Build the UI, stub the backend with a clear TODO.
- **Shareable:** a "Share my score" affordance (the viral vector).
- Reuses the app's identity; links into the full matcher.

### 2. Landing page: honest-no hero
- **Hero:** the outcome-first line + a real *"We don't recommend applying. Here's where to look instead"* verdict card as proof (the app already renders this beautifully).
- **Sections:** hero → the problem (3 weeks wasted on the wrong grant) → how it works (3 steps) → the differentiator (grounded + honest vs. a sycophantic chatbot) → "Free to start" + one-line privacy assurance → a linked **sample map** (the orphaned `/demo`, finally surfaced) → single CTA into an **ungated** search.
- **SEO/AEO baseline:** real `<title>`/description/OG/Twitter tags, `Organization` + `SoftwareApplication` JSON-LD, brand name "Granted" (today's metadata says "Government Opportunity Finder").

### 3. Ungated, fast-feeling first run
- **Do not gate the first search behind Google sign-in.** (The code already doesn't gate `/api/match`; if prod forces OAuth first, that's a config toggle to flip. A one-line win, not a rebuild.) Make sign-in a *post-result* reward ("save this map").
- **Never a blank 90s spinner:** the match route already streams NDJSON stage events. Surface them ("Extracting profile → Searching 968 programs → Scoring fit → Checking eligibility → Reading the honest verdict").

## Pricing (bootstrapped launch)

- **Free forever, email-gated:** full match → fit score → eligibility → **honest verdict** (cap ~3–5 runs/mo, 1 saved profile). This is the wow + the lead magnet. Do not cripple it.
- **Max (~$49/mo _or_ ~$149 one-time per-application unlock):** deep competitor/awarded-grant intelligence + application drafting. Usage is episodic, so the per-application unlock fits behavior; ship **one** paid decision at launch.
- **Founding-member lifetime deal:** pull first cash + testimonials forward.
- Monetize the **yes-path** (the founder who got a "yes" and faces a $50k–$1.5M application), never the honest-no.

## 90-day plan

**Weeks 1–2, Foundation (this `/ship` build):** landing page + free readiness tool (email UI, stubbed backend) + metadata/JSON-LD + link the demo. Buy a real domain. Add basic analytics + the streamed match progress. Ungate the first search.
**Weeks 3–4, Concierge + first proof:** hand-run 10–20 fit reviews for founders sourced from one intermediary; harvest reactions to the honest-no; turn 3–5 into public case studies. "Show HN" + a couple of founder communities with the contrarian hook.
**Weeks 5–8, Compounding content:** 3–5 grounded award-teardown / eligibility pages (SEO + AEO); publish `llms.txt` + open AI crawlers; repurpose across LinkedIn/communities.
**Weeks 9–12, Intermediary partnerships:** convert 2–3 TTO/SBDC/accelerator relationships into embedded/linked distribution; add the viral share card once the tool has usage; test the founding-member deal.

## Metrics to track

- **Top-funnel:** landing → free-tool starts (activation rate), tool completion rate.
- **Aha:** free-tool completion → email capture rate; free-tool → full-search rate.
- **Trust proof:** share rate of the readiness card / honest verdict.
- **Retention/revenue:** saved profiles, return runs, Max conversions on the yes-path.

## Distribution checklist

- [ ] Landing page live with honest-no hero + ungated CTA
- [ ] Free "Grant Readiness Score" tool live (no signup)
- [ ] Email capture UI (backend stubbed with TODO)
- [ ] Real `<title>`/description/OG + JSON-LD; brand = "Granted"
- [ ] `/demo` sample map linked from the landing page
- [ ] First search ungated; match progress streamed in the UI
- [ ] Real domain purchased
- [ ] Analytics on the funnel
- [ ] `llms.txt` + AI crawlers allowed (Weeks 5–8)
- [ ] 3–5 grounded content/SEO pages (Weeks 5–8)

## Time-wasters (skip pre-users)

- Perfecting the Max tier (competitor polish, app-drafting, grants.gov S2S). All still mock. Sell it concierge; productize on proven demand.
- Broad new-source ingestion, an SEO-tooling build-out, or a design-system redesign. Ship one clean page and move on.
- Paid ads (moot at $0).
