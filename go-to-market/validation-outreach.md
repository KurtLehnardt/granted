# Granted: Demand-Validation Outreach Kit

_The goal of this week is **evidence, not growth**: get 10–20 real founders to use Granted and tell you whether the honest "don't apply" changes what they do. If 3–5 say "this saved me weeks," you have a wedge worth marketing. If they shrug, it's a nice utility, not a business. Everything below is built to run that test cheaply._

**Live:** `https://fund-finder-blush.vercel.app` · free tool: `/readiness` · landing: `/welcome`
**Before you post:** buy a real domain (a `granted.*` beats a `fund-finder-blush.vercel.app` for trust), and confirm the first search isn't gated behind Google sign-in (kills cold-visitor conversion).

---

## 1. Show HN post

**Title (≤ 80 chars, no "Show HN:" double-up; HN adds nothing, you type it):**
> Show HN: Granted – a federal grant finder that tells you when NOT to apply

**Body:**
> I built Granted because every "grant finder" (and every chatbot you paste your pitch into) is basically incentivized to tell you to apply. Grants.gov lists everything and scores nothing; an LLM will happily invent a perfect-sounding program that doesn't exist and cheer you on.
>
> Granted does the opposite. You describe your company in plain English, and it maps you against 968 real federal opportunities (grants, SBIR/STTR, procurement, loans, assistance; from grants.gov, SAM.gov, SBIR, and USAspending), scores fit on the criteria a program officer would actually apply, and (the part I care about) it will tell you *"we don't recommend applying"* when the honest answer is that you'd waste three weeks on a grant you can't win. It backs that up with where to look instead.
>
> Two design constraints I held throughout:
> - **Grounded, never fabricated.** Every match traces to a real award record; a schema layer *throws* on any invented program/amount/citation, so it structurally can't hallucinate an opportunity.
> - **Calibrated to say no.** I validated the discernment layer against a golden set of real company profiles, including deliberately weak/ineligible ones (a consumer app with no R&D, an over-the-size-cap firm, a foreign-owned company applying to SBIR). It returns a clean "don't apply" on those instead of a wall of maybes.
>
> There's also a 60-second free "Grant Readiness Score" that checks the hard federal gates (entity, SAM.gov registration, UEI, small-business size, R&D component) before you sink time into anything: [link]/readiness
>
> It's free. I'm at zero users and genuinely want to know: **is an honest "don't apply" actually useful to you, or do you just want more matches?** Especially keen to hear from anyone who's chased (or bailed on) an SBIR/STTR. Roast it.

**HN tips:** post Tue–Thu, ~8–10am ET. Reply to every comment fast and non-defensively. The honesty angle + the "throws on hallucination" detail is what will resonate with that crowd. Lead with substance, not hype.

---

## 2. Founder-community post (r/SBIR, r/smallbusiness, IndieHackers)

_Shorter, less "launch," more "made this, want your gut-check." Read each sub's self-promo rules first; lead with value, not the link._

> **I built a free tool that tells you *not* to apply for federal grants (when that's the honest answer)**
>
> I kept seeing founders (myself included) burn weeks on SBIR/grant applications they were never going to win. So I made Granted: describe your company, and it scores your fit against real federal programs and gives you a straight verdict, including "don't apply, here's why, look here instead." It won't invent programs to keep you hopeful.
>
> There's a 60-second readiness check (SAM.gov / UEI / size / R&D gates) before you commit to anything: [link]/readiness
>
> It's free and I have no users yet. I mostly want to know if an honest "no" is useful or if people just want a longer list. If you've done an SBIR, I'd love to hear whether the verdict matches your experience.

---

## 3. Cold email to a funding intermediary (TTO / SBDC / APEX Accelerator)

_Short, specific, one ask. These orgs are chartered to help founders find non-dilutive funding. You're handing them a free tool that makes them look good. Subject lines matter most._

**Subject:** A free grant-fit tool for your [founders / clients], would love your read

> Hi [Name],
>
> I run Granted, a free tool that helps founders figure out whether a federal grant is actually worth chasing *before* they spend three weeks writing one they can't win. It maps a plain-English company description to real federal programs (SBIR/STTR, grants, etc.), scores fit, and, unlike most tools, will honestly say "don't apply" when that's the right call, with a redirect to better-fit options.
>
> I'm reaching out to [TTO / SBDC / APEX Accelerator] because you're exactly who founders trust for this, and a first-pass "should I even apply?" gut-check might save your [founders / clients] real time before they book an advising session.
>
> It's free, no login to try: [link]/readiness (60-second readiness score) or [link] for the full map.
>
> Two asks, either is great: (1) would you try it and tell me if it'd be useful to your founders? (2) if it clears your bar, would you be open to sharing it in a newsletter/Slack/office-hours? Happy to do a 15-min call and tailor anything to your programs.
>
> Thanks for what you do for founders,
> [Your name] · [email] · [link]

---

## 4. Ranked target list: ~10 specific intermediaries

_Ranked by yield-per-effort for a bootstrapped, pre-users launch. **Start Tier 1 (Utah).** The app already ships real Utah/SBA redirects, so you have local credibility and warm-intro proximity. Then go national on the SBIR-dense orgs._

### Tier 1: Warm/local start (Utah; the tool already knows this ground)
| # | Org | Type | Why it fits | How to reach |
|---|---|---|---|---|
| 1 | **University of Utah — PIVOT Center** | University TTO / commercialization | Chartered to move faculty/student ventures toward non-dilutive funding; SBIR-active | TTO site → "contact" / commercialization staff on LinkedIn; warm intro if you have any U of U tie |
| 2 | **Utah SBDC (Salt Lake Community College network)** | SBDC | Advises small businesses on funding; a "should I apply?" pre-screen saves advisor time | Utah SBDC site → nearest center director; short email (template §3) |
| 3 | **GO Utah — Utah SBIR/STTR Assistance** | State econ-dev / SBIR support | State program literally exists to get Utah firms SBIR-ready | GO Utah SBIR page → program manager email |
| 4 | **BioUtah / Silicon Slopes** | Industry association / founder community | Direct line to Utah startup founders (your ICP) via newsletter/Slack | Membership/community contact; offer the free tool as a member perk |

### Tier 2: National, SBIR-dense, high-yield
| # | Org | Type | Why it fits | How to reach |
|---|---|---|---|---|
| 5 | **Georgia Tech — ATDC / VentureLab** | University incubator + I-Corps | One of the most SBIR-active university programs in the US | ATDC site → program directors; LinkedIn |
| 6 | **Larta Institute** | NIH/USDA SBIR commercialization partner | Runs federal SBIR commercialization programs; deep exact-ICP audience | Larta site → programs contact |
| 7 | **America's SBDC (national network)** | SBDC umbrella | 900+ centers; one national champion → many local centers | national site → resource-partner / tech contact; start with one enthusiastic local center |
| 8 | **APEX Accelerators (formerly PTACs)** | Gov-contracting assistance | Founders here are already pursuing federal money; procurement + SBIR overlap | apexaccelerators.us → find your state center |

### Tier 3: Accelerators & national programs (slower, higher ceiling)
| # | Org | Type | Why it fits | How to reach |
|---|---|---|---|---|
| 9 | **NSF I-Corps (national network / regional hubs)** | Deep-tech commercialization | I-Corps teams are prime SBIR/STTR applicants | Regional hub program managers |
| 10 | **gener8tor — gBETA** | Free accelerator, many markets | Program managers actively hand founders free tools; non-dilutive focus | gener8tor site → gBETA managers by market |

---

## 5. How to run the test (the actual point)

1. **Post** the Show HN + one community post; **send** 4–5 intermediary emails (start Tier 1). Keep it to ~2 hours of effort.
2. **Watch the first 10–20 runs.** If you can, do a few by hand ("concierge"): DM a founder, run it with them, watch their face at the verdict.
3. **Listen for one signal:** does the honest "don't apply" (or "worth pursuing") change what they'd actually do? Do they trust it?
4. **Decision gate:**
   - **≥3–5 founders say "this saved me weeks" or an intermediary asks to share it → real wedge.** Go build the intermediary channel (embed widget, more free tools, content/AEO).
   - **Mostly shrugs / "I just want more matches" → it's a useful utility, not a venture.** Keep it free as a brand/lead-magnet, don't invest in paid growth.

**Track it simply** (a spreadsheet is fine): source · runs · completed · email captured · verdict trusted? · quote. That table *is* your answer to "is Granted worth marketing?"
