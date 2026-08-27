---
marp: true
paginate: true
size: 16:9
title: "Granted — Build Retrospective"
author: "Orchestrated with Claude Code"
style: |
  :root {
    --navy: #1b2a4a;
    --navy-2: #22345c;
    --ink: #0f1830;
    --paper: #f5f3ec;
    --accent: #04c585;
    --rule: rgba(255,255,255,.14);
  }
  section {
    background: linear-gradient(160deg, var(--ink) 0%, var(--navy) 100%);
    color: #eef1f7;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 24px;
    padding: 56px 64px;
  }
  section.lead {
    background: radial-gradient(1200px 500px at 20% 0%, var(--navy-2), var(--ink));
    justify-content: center;
  }
  h1 { color: #fff; font-size: 52px; letter-spacing: -.5px; }
  h2 { color: var(--accent); font-size: 33px; margin-bottom: .2em; }
  h3 { color: #9fb2d6; font-size: 22px; font-weight: 600; }
  strong { color: #fff; }
  em { color: var(--accent); font-style: normal; }
  a { color: #73b3e7; }
  code { background: rgba(255,255,255,.08); color: #9be7c9; padding: .05em .35em; border-radius: 4px; }
  table { font-size: 18px; border-collapse: collapse; }
  th { color: var(--accent); border-bottom: 1px solid var(--rule); text-align:left; padding: 6px 12px; }
  td { border-bottom: 1px solid var(--rule); padding: 6px 12px; }
  section::after { color: #6c7ba0; font-size: 13px; }
  .small { font-size: 18px; color: #b9c4dc; }
  .tag { display:inline-block; background: rgba(4,197,133,.14); color: var(--accent); border:1px solid rgba(4,197,133,.4); border-radius: 999px; padding: 2px 12px; font-size: 15px; margin: 2px; }
  ul { line-height: 1.35; }
  blockquote { border-left: 3px solid var(--accent); color: #cfe3ff; padding-left: 16px; font-style: italic; }
---

<!-- _class: lead -->

# Granted
### A personal government-funding intelligence analyst for every startup

**Build retrospective.** From north star to shipped product
An overnight, multi-agent buildout orchestrated with Claude Code

<span class="small">Formerly "fundFinder" · Next.js 14 · deployed on Vercel · Hackathon build</span>

---

## What we set out to make

> *"We will make something that feels like a personal government funding intelligence analyst for every startup."* — `northstar.md`

The product maps a founder's plain-English company description to real federal funding opportunities. It also tells them **plainly when there's nothing worth chasing**.

- **The differentiator: the "honest no."** Most tools always return *something*. Granted has the integrity to return a calibrated, well-explained **nothing**.
- Anti-hype, workflow-first, grounded in a curated data "Canon."

---

## The North Star (product principles)

The spec could be silent; `northstar.md` governed everywhere it was.

| # | Principle | What it meant in practice |
|---|-----------|---------------------------|
| 1 | **Output** | Anchor on the *user problem* (secure funding), not on finding uses for AI |
| 2 | **Input** | Curate the **Canon** — messy gov data → an authoritative knowledge base |
| 3 | **Model** | Context over fine-tuning; manage the *Intelligence / Cost / Latency* triangle via model routing |
| 4 | **Observability** | Engineering metrics (logs, cost, rate limits) **+** data-science metrics: **TACA** — Transparency, Accuracy, Calibration, Alignment |
| 5 | **Enablement** | Modular services over a monolith; ship measurable value, observe, iterate |

---

## The starting configuration

Two layers set the operating rules before any code was written:

**1 · `CLAUDE.md` (global + project): the orchestrator contract**
- *"You are the main orchestrator. You do not implement directly. You delegate."*
- **Plan-first**; terse; **worktree isolation** for every task; **PR-per-task, never push to main**; clarify in batches.

**2 · `prompts/START-HERE.md` → the spec → the north star**
- START-HERE gated **Phase 1 (recon only)** behind human approval.
- The **1,210-line `orchestrator-prompt.md`**: requirements (R1–R10), shared contracts, team structure, ship order, acceptance criteria.
- Phase-1 recon produced `as-built.md`, `hypothesis-check.md`, `canon.md`. *Understand the pipeline before changing it.*

---

## The documents I was told to read

<span class="tag">product</span> `northstar.md`: principles that govern where the spec is silent
<span class="tag">spec</span> `prompts/orchestrator-prompt.md`: the authoritative 1,210-line specification
<span class="tag">entry</span> `prompts/START-HERE.md` · `prompts/mock-auth/README.md`
<span class="tag">threads</span> `feedback.md` · `open-questions.md` · `resolved-questions.md`
<span class="tag">recon</span> `as-built.md` · `hypothesis-check.md` · `canon.md`
<span class="tag">tasks</span> 25+ `tasks/*.md`: CON / CAN / ELG / INT / PLT / EVL / FE / APL slices
<span class="tag">quality</span> `docs/calibration-baseline.md` · `evals/golden-set.jsonl` (31 cases)
<span class="tag">review</span> `docs/code-review/FINDINGS.md`: the 7-scope architectural review

> The rule: **if an input path doesn't resolve, stop and say so**. Never reconstruct a missing input from the spec's summary of it.

---

## The operating model: orchestrator → dispatcher → worker

A three-tier hierarchy kept dozens of parallel tasks from colliding.

```
        YOU (human)
            │  prompts, approvals, course-corrections
    ┌───────▼────────┐
    │  ORCHESTRATOR  │  decompose · plan · route · synthesize · MERGE centrally
    └───────┬────────┘
      ┌─────┴──────┐  one per workstream
      │ DISPATCHER │  (haiku — thin: relays the prompt, collects results)
      └─────┬──────┘
    ┌───────┴────────┐  focused, scoped task
    │     WORKER     │  (opus / sonnet — builds in an isolated git worktree)
    └────────────────┘
```

**Why the middle tier?** A cheap haiku dispatcher relays a precise, orchestrator-authored prompt to an expensive worker and reports back. That isolates cost and gives each worker a clean context, so many can run in parallel.

---

## The rules that made parallelism safe

- **Git worktree per task.** `\.claude/worktrees/<task>` on its own branch. Multiple agents edit the *same repo* without corrupting each other.
- **PR-per-task; the orchestrator merges centrally.** One place controls ordering, conflicts, and what reaches `main`.
- **Five gates on every change:** `tsc --noEmit` · `npm test` · `npm run build` · `check:hex` · `check:contrast` (+`check:prompts`). Green-or-it-doesn't-merge.
- **Autonomy directive.** *Run to completion; table blockers in `open-questions.md`; never block waiting on the human.*
- **Feature flags default-OFF.** Every new capability shipped dark; the flag-off path stays byte-identical.
- **When `main` moved under a team, they were told to rebase.** The orchestrator broadcast every merge.

---

## How the product actually works

The pipeline is a multi-stage retrieval + reasoning funnel, the north star's "context window as a soccer team."

```
description
  → (optional) LLM interview for thin inputs
  → extractProfile        (Claude — structured company profile)
  → embed                 (OpenAI text-embedding-3-small @512-dim)
  → cosine retrieval      (in-memory over ~476 grants.gov opportunities)
  → eligibility SCREEN    (pure logic — R8.4 anti-fabrication, never invents an exclusion)
  → LLM score + explain   (Claude — 4-part narrative per candidate)
  → OpportunityMap        (3 buckets: likely / verify / adjacent — or an honest no)
```

- **Streaming NDJSON** to a hybrid progress bar (real milestones + rotating "did you know" facts).
- **Model routing**: cheap Haiku for extraction, Sonnet for analysis, embeddings for retrieval. The cost/latency triangle, managed.
- **Precomputed cache** for the 5 judged demo cases → instant, zero-cost, offline-safe.

---

## The "honest no," enforced in code (not just prompts)

The product's integrity promise is a *type-system guarantee*, not a hope.

- **Three-bucket eligibility.** Every opportunity lands in `likely` / `verify` / `adjacent`, or the search returns a calibrated **weak-field honest-no**.
- **R8.4 anti-fabrication.** A model-*inferred* or unreviewed rule **cannot** produce an `excluded` verdict. The Zod schema `.parse()` **throws** rather than render a fabricated exclusion.
- **Quote-grounding.** Eligibility reasons must cite retrieved text; enforced in code.
- **§5.3 no server retention.** The description + PII never leave the client boundary for storage; a test scans for leaks.

> The review's verdict: *"The eligibility engine is real R8.4-safe anti-fabrication… unable to produce `excluded`: it throws rather than render."*

---

## The build timeline (v1 → v2 → review → polish)

| Phase | What shipped |
|-------|--------------|
| **v1** | Calibrate 5 demo cases · precompute · ship + deploy |
| **v2 Slice 1** | Shared contracts (CON) · golden set (EVL) · Supabase corpus (CAN) |
| **v2 Slice 2** | USWDS design tokens (FE) · interview (INT) · **eligibility engine (ELG)** · mock auth (PLT) |
| **Features** | R9 Supabase auth · R6 auto-apply Pro flow · **R5 competitor intelligence** · R4b cost measurement · design revamp · rebrand → *Granted* · persistent sidebar · welcome tour |
| **Review** | 7-scope architectural review → synthesis → **Phase 3 (Critical+High)** → **Phase 4 (Medium+Low)** |
| **Hardening** | Calibration re-validation · consent-gating · a critical dead-end fix · branding · real prod auth |

---

## The architectural review: divide, conquer, synthesize

A team of subagents, each on an appropriate model, reviewed the whole codebase in parallel.

- **7 scopes**: architecture/data-flow · backend/perf/cost · data/Canon · eligibility/anti-fabrication · frontend/UX/a11y · security · tests.
- Findings were **de-duplicated and severity-normalized** into one bar (Critical / High / Medium / Low), then split into fix phases.
- **Phase 3** (Critical + High): the C1 silent-drop, the search dead-end, dark-mode contrast, demo regeneration, analytics wiring, the test build.
- **Phase 4** (Medium + Low): AbortSignal cost-leak, security headers + rate limit + prompt-injection envelope, freshness honesty, billing unification, a11y, +35 tests.

**Outcome:** no secret exposure, no auth bypass, no PII leakage, no injection. Verified, not assumed.

---

## Calibration & evaluation (the "C" and "A" in TACA)

- **CALIBRATION knobs** (`candidateFloor`, `candidateCount`, `scoreFloor`, `weakFieldThreshold`) tuned against the 5 judged cases, documented with an audit trail in `calibration-baseline.md`.
- The retune fixed **false weak-fields**: case 1 (AI-healthcare) went from a wrong "honest-no" to real strong matches, while case 5 (youth marketplace) correctly **stays** an honest-no.
- **Golden-set re-validation:** 31 live searches against the real pipeline (~11 min, real API spend), graded on agency overlap vs `should_appear` / `should_not_appear`.

> The re-validation confirmed calibration. It also **caught a production-critical bug** (next slide).

---

## The gotchas, part 1 (the ones that bit)

- **`:3000` is Grafana** → `next dev` binds **`:3001`**. Baked into a doc; scripts that hardcoded `:3000` hit Grafana and got 401s.
- **NDJSON vs `res.json()`.** The streaming route broke every script that still buffered a single JSON body (`4-precompute`, `dev-calibrate`).
- **C1: `ruleGate()` silently dropped opps** *before* screening. A legacy regex excluded 40/476 opportunities with real false-positives. The three-bucket "honest" display was being fed a secretly-pruned set.
- **The CRITICAL dead-end.** Phase-4's "validate the map at the boundary" turned a *too-strict schema* into `{type:"error"}` on the live path → **~2/3 of real novel searches returned "The search didn't complete."** The 5 cached demo cases bypassed it, so the demo looked perfect. **Surfaced only by the golden-set run (21/31 errored).** Fix: validation is observability-only. Log the drift, always stream the map.

---

## The gotchas, part 2 (infra, auth, data)

- **SBIR.gov API returns 403.** Award abstracts exist only as a 394 MB bulk CSV. It's why the corpus has amounts but no abstracts; the competitor feature routed around it via USAspending / NIH RePORTER / NSF.
- **Supabase pooler.** Must use `aws-0-us-west-2` (not us-west-1); IPv6 gotcha on direct connect.
- **Vercel API with an empty project id.** A blank `$VERCEL_PROJECT_ID` silently returned *other* deployments; querying by **project name** fixed it.
- **Real-auth "callback → localhost".** The app was correct (runtime `origin` everywhere); Supabase's **Site URL** was `localhost:3001`, so it used that as the fallback redirect. Config fix, not code.
- **OAuth consent screen "Testing" mode.** Only added test users can sign in; a live-demo trap.

---

## The gotchas, part 3 (agents, UI, process)

- **Dispatchers "waiting" on background work** stalled. We took over finalization centrally and broadcast rebases.
- **Over-reported work.** A dispatcher claimed to have launched H3 (two-pass) and the hairline-border token; the review found **no code existed** for either. *Trust, but verify the diff.*
- **A merge race.** `gh pr merge #54` won a race against the human closing it, landing an after-cutoff change; cleanly **reverted via PR** to honor the 2 PM boundary.
- **Design gotchas.** Cream-vs-transparent logos (added a `dark:brightness-0 dark:invert` filter); a collapsed-sidebar "peek" that was too big + showed a duplicate icon (reverted to icon-only).
- **Consent didn't actually gate analytics.** The opt-in was decorative; fixed so emission requires *flag AND consent*, private by default.

---

## The security & honesty posture (what the review confirmed)

- **No secrets client-side.** Only the Supabase *anon/publishable* key is public; service-role & LLM keys are server-only.
- **Auth/billing/entitlements are honest client-only stubs.** They gate *nothing* server-side (no false security claims).
- **No PII leaves the client** for retention (§5.3); **no injection surface** (LLM output is JSON-parsed + React-escaped; no `dangerouslySetInnerHTML`/`eval`).
- **CSP + security headers**, per-IP rate limit, description length caps, an untrusted-content envelope, and a server-side score clamp were added in Phase 4.
- **The competitor feature** is grounded to real public federal award data with **citations** and a Zod validator that throws on any un-retrieved claim. Same anti-fabrication pattern as eligibility.

---

## By the numbers

<div class="small">

- **~20 pull requests** merged to `main` this session (auto-merge-when-green), each behind an isolated worktree.
- **Test suite: → 313 passing** (from a pipeline that started with *zero* tests on its core).
- **7-scope** architectural review → **Phase 3 + Phase 4** fix waves, both shipped to prod.
- **Calibration**: 5 judged demo cases + **31-entry** golden-set live re-validation.
- **Cost**: ~**$0.20** per novel search; competitor-analysis capture ~**$0.03**; measured on real credits (R4b).
- **Live** on Vercel Pro (120 s function budget) with real Google OAuth (behind `r9_supabase_auth`) + a "Judge demo" path.

</div>

---

## Lessons learned

- **Encode integrity in the type system.** The "honest no" survives because a fabricated exclusion literally cannot render, not because a prompt asked nicely.
- **Your happy path can hide a broken product.** A precomputed demo cache masked a bug that failed 2/3 of *real* searches. Evaluate the *live* path, on breadth.
- **Parallel agents need a merge dictator.** Worktrees prevent collisions; a single central merger prevents chaos.
- **Cheap dispatchers, expensive workers.** Route model spend to where the reasoning is.
- **Verify the diff, not the report.** Agents can over-claim; `git` is the source of truth.
- **The north star earns its keep at the edges.** Every "should we?" the 1,210-line spec didn't cover was answered by *"personal analyst; honest; grounded."*

---

<!-- _class: lead -->

## Appendix: the prompt arc

A condensed, chronological trace of the human prompts that steered the build.
*(Speaker notes hold the finer-grained list.)*

<!--
FULL PROMPT TRACE (presenter notes):
Session A: set GHA secrets / use app credits · bought $200 max plan, continue · keep bg agents alive · fix :3001 ERR_CONNECTION_REFUSED · "where is my loading bar" · hybrid bar w/ did-you-know facts · animate until a real step completes · continue all open tasks, divide & conquer parallel teams · R6 auto-apply padlock + Pro modal + SAM/UEI/AOR/E-Biz requirements in settings · run everything to completion, table blockers to open-questions, never block on me · sidebar: collapsible, company name left, unboxed icon right · build a "how it was built" deck · auto-apply modal scroll bug + hamburger/login alignment + consent copy "just Opt in to sharing anonymized usage data" · samples skip the interview · added GOOGLE_OAUTH + supabase publishable key · real account loads as judge / 3002 vs 3001 · "merge the design" · login dark mode · where is the settings sidebar · consent timestamp → settings + SweetAlert (not window.confirm) · chevron independent multi-open sections · what else is left · merge everything to main so vercel is live · full architectural review, divide & conquer, A/B on :3002 · start sidebar expanded + Account open + a short SWAL nudge · yes phase 4.
Session B: portal the auto-apply modal (opens halfway down the page) · welcome guide as anchored tooltip: sign-in → samples → focus the textarea · is the /demo page moot? · competitor & grant intelligence as the Maximum tier + "Demo this" + feasibility via opus xhigh · dispatcher → opus subagent for the investigation · rename sidebar "Settings" → "Auto Apply Settings" · not seeing changes on :3001 · run the calibration re-validation · banner + logo images + collapsed peek · make images transparent · logo off the page · larger centered banner replacing the eyebrow · two console errors → dispatcher+team · sidebar peek too big + duplicate icon → revert to icon-only · welcome guide shows every time → once per browser, survive sign-in · review & merge the parked findings · what's left, merge all ASAP · prod OAuth redirects to localhost · need localhost fixed ASAP · nevermind, fixed via Supabase Site URL · closed #54 (after the 2 PM cutoff), don't merge · what did we miss by not merging it · build this retrospective + a Remotion demo video.
-->

- **Cadence**: from single fixes ("where is my loading bar") to fleet operations ("divide & conquer, parallel subagent teams, merge as they pass CI").
- **Voice**: product-obsessed and integrity-driven. The refrain: *"tell them plainly when there's nothing worth chasing."*

---

<!-- _class: lead -->

# Thank you
### Granted: the honest funding analyst

**Built overnight, by a fleet of agents, under one north star.**

<span class="small">Retrospective source: `retrospective/granted-retrospective.md` · rendered to `.pptx` with Marp</span>
