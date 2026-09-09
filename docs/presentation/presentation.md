# fundFinder — How It Was Built
### Slide-by-slide script (16 slides) · Hackathon presentation · the multi-agent orchestration story

> Source of truth: `build-narrative.md` (same folder). Every number here is verified against a repo
> artifact, a merged PR, or the authentic build-session transcript. Honesty markers are kept in.

---

## Slide 1 — Title

**fundFinder: how a fleet of agents built it in a day**
*A personal government-funding intelligence analyst for founders — built by an orchestrated
multi-agent system.*

- GOED bounty · AI Builder Day · Aug 15, 2026
- Live demo: **https://your-app.example.com**
- Repo: **https://github.com/KurtLehnardt/granted**
- Built by one orchestrator agent + specialized subagent teams — **21 merged PRs in ~8 hours**

---

## Slide 2 — The problem & the North Star

**Founders can't see the federal funding that fits them — and generic AI will hallucinate five matches for anyone**

- Grants/SBIR/STTR/procurement hide behind agency vocabulary founders don't speak
- North Star: *"a personal government funding intelligence analyst for every startup"* — anchor on the
  user problem, not on finding uses for AI
- Manage the triangle: **Intelligence / Cost / Latency**, with model routing
- **Calibration is the product**: the win is saying *"probably not a fit"* and explaining why
- Link: https://github.com/KurtLehnardt/granted/blob/main/northstar.md

---

## Slide 3 — What it does

**Describe your company in plain English → get a Government Opportunity Map**

- Not a search engine ("what grants say AI?") — an analyst ("I'm a Utah AI-health startup, 15 people,
  $1M ARR — what should I know?")
- Each match: **why it fits / why it might not / what to verify / what to do next** + similar-company
  award history
- Three honest eligibility buckets — **eligible / conditionally eligible / excluded** — plus **unknown**
- **Test case 5 (Youth Marketplace)** is the proof: it must decline, not fabricate
- Link (5 judged cases): https://github.com/KurtLehnardt/granted/blob/main/README.md

---

## Slide 4 — The build method (this is the story)

**One orchestrator agent. Specialized dispatcher → worker subagent teams. Isolated worktrees. PR per task.**

- Human's kickoff: *"You are an orchestrator, not a worker… dispatchers spin up their own subagents…
  these subagents must work in git worktrees"*
- Every finished task gets a **critical-reviewer subagent (opus)**; critical/high findings must be fixed
  before merge; a dispatcher **auto-merges PRs when clean**
- **Model/effort routing:** small→haiku, medium→sonnet, large→opus; **all reviewers run opus**
- Many slices ran **in parallel** — one branch = one subagent's isolated worktree
- Link: https://github.com/KurtLehnardt/granted/blob/main/prompts/START-HERE.md

---

## Slide 5 — Recon before build: catching a wrong spec

**A mandatory recon-and-stop gate proved the spec was solving a partly-wrong problem — before any code**

- `START-HERE.md`: *"Do not write task files… Do not begin implementation"* until recon is signed off
- Recon produced `as-built.md`, `hypothesis-check.md`, `canon.md`
- **3 of the spec's 4 hypotheses refuted** by reading the actual code:
  - "queries a live grant API per request" → **false** (already a local pre-embedded corpus)
  - "the pipeline is one big prompt" → **false** (already a composed chain)
  - real risk wasn't latency — it was **data staleness**
- Re-scoped Canon + Perf slices instead of building non-problems
- Link: https://github.com/KurtLehnardt/granted/blob/main/hypothesis-check.md

---

## Slide 6 — The decomposition

**~1,200-line spec → team-scoped task families → a dependency graph**

- Tasks are markdown files (`tasks/*.md`), **not** GitHub Issues — an explicit owner decision
- Teams: **CON** contracts · **CAN** canon/data · **INT** interview · **ELG** eligibility ·
  **FE** frontend · **PLT** platform · **EVL** evals · PIP/PRF/VER/ITL/APL (later)
- **Contracts (zod) freeze first** and block everyone; feature-flag everything, default off
- Critical path: `CON-01 → CAN-01 → CAN-04 → ELG-01 → INT-02/FE-03`
- **Slices 1–3 shipped** in the window; slices 4–8 remain planned specs (honest scope)
- Link: https://github.com/KurtLehnardt/granted/blob/main/task-graph.md

---

## Slide 7 — Parallelism, proven in the merge log

**"Many slices in parallel" isn't a claim — it's visible in the PR timeline**

- **21 merged PRs** on one day (2026-08-15, ~05:42–13:50 UTC)
- **PRs #7, #8, #9** (Eligibility, Interview, Frontend) merged **within the same minute**
- **PRs #12–#15** cluster at 11:33–11:34 — four independent teams landing on `main`
- Branch convention `v2/<team-task>` maps 1:1 to worktree isolation
- **No self-merge**: review is always by a different agent than the author

---

## Slide 8 — Architecture (the request path)

**Interview → extract → embed → retrieve → screen → score → honest finding**

- **Interview (optional):** `gpt-4o-mini`, gate-first, **median 4.1s** — ask cheap questions *before* the search
- **Extract profile** → `claude-sonnet-4-6`; **embed** query → OpenAI `text-embedding-3-small`, **512-dim**
- **Retrieve:** cosine over the **476-opportunity** pre-embedded corpus — **no government API call at request time**
- **Screen** → eligible / conditional / excluded / unknown; **score** → `claude-sonnet-4-6`,
  parallel-batched (`Promise.allSettled`, batches of 8)
- Model-routing table sends cheap subtasks to cheap models; expensive analysis stays on the analysis model
- Link: https://github.com/KurtLehnardt/granted/blob/main/as-built.md

---

## Slide 9 — The latency hurdle

**Novel-input search: ~180s → ~98s — by parallel-batching the LLM scoring**

- The deployed experience *felt* like a ~3-minute wait; recon showed the corpus was **already local +
  pre-embedded** (fetched offline once, committed as static JSON) — so the bottleneck was **LLM
  generation, not live API calls**
- Fix that moved the number: `explainMatches` went serial → **`Promise.allSettled` over batches of 8**
  → **~180s to ~98s** (measured, `as-built.md`); cached demo cases render **instantly**
- Streaming progress shipped (NDJSON milestones) so the wait is legible
- **Honest caveat:** the sub-60s p95 target is Perf work that **wasn't fully shipped**; Supabase pgvector
  is **built + tested but not yet wired** into the live path
- **The hybrid future:** local retrieval + scheduled ingestion + live freshness check *only on surfaced
  opportunities* (fully-live-per-request was rejected)

---

## Slide 10 — Honesty by construction, not by prompt

**"Never let a model inference wear the costume of a verified fact"**

- Only a **reviewed** rule (verified / user-stated) can **exclude** a company
- A **`model_inferred` rule can never gate** — it degrades to **unknown**; a zod `.parse()` backstop
  **throws** if anything tries to exclude on inferred grounds (defense in depth)
- **unknown → unknown**, never a guess
- Every asserted rule carries a **verbatim quote + source URL** (SBA Policy Directive · 13 CFR 121.702 · 2 CFR 25)
- **Measured: 0 false exclusions** — across 24 golden-set checks (build-blocking) **and** 160 live determinations

---

## Slide 11 — The eval caught a real bug — and we read it honestly

**Calibration is measured, and the measurement itself is calibrated**

- Golden set: **31 cases**, frozen at **v1.0** (`sha256:f79c6e57…`), owner citation-checked and
  labeled *"not a domain expert"*
- Interview eval: **code-level checks passed 31/31**; the LLM-judge headline was **noisy** and was
  *not* treated as a quality score
- Manual audit found **1 genuine re-ask bug** (interview re-asked US-ownership after "70% foreign-owned")
- Fixed one PR later by a **prompt v1→v2 bump** (PR #19) — the eval, read honestly, found it
- Link: https://github.com/KurtLehnardt/granted/blob/main/README.md

---

## Slide 12 — Mocking what needs government approval

**Auto-apply is a Pro-gated stub — honest about waiting on approval, because the real thing is legally gated**

- Real submission needs the **founder's** SAM.gov registration + **UEI**, an authorized **AOR**, and
  **E-Biz POC** delegation — plus approved gov API access
- **fundFinder legally cannot be the applicant's AOR / E-Biz POC** (SAM.gov Terms of Use)
- So "Auto Apply" ships as a **UI-only stub**: padlock + "Pro" modal, **never submits, gates nothing
  server-side, stores no credentials**
- Backed by a **research-only feasibility memo** (APL-01) gated on legal review — recommendation:
  **package-builder + human review-and-attest + human submits**
- Link: https://github.com/KurtLehnardt/granted/blob/main/docs/R6-s2s-feasibility-memo.md

---

## Slide 13 — Key features shipped

**A calibrated matcher, behind honest flags**

- **Pre-search interview** (gpt-4o-mini, gate-first) · **3-bucket eligibility screening** + unknown
- **Government Opportunity Map** with why-fit / why-not / verify / do-next + award history
- **Freshness annotation** (no showing closed grants as open) · **streaming progress** (NDJSON)
- **USWDS 60/30/10 design system** (navy #005ea2, green CTA #538200) — **19/19 WCAG-AA** pairings
- **Mock auth + local-only persistence** (nothing retained server-side, proven by test) · **typed analytics**
- **8 feature flags, all default-off** — one-flag revert per requirement

---

## Slide 14 — Hurdles overcome

**Real-world friction, from the actual build session**

- **Vercel "No Next.js version detected"** — app lives in `scaffold/`, not repo root → set **Root
  Directory = `scaffold/`** (verified via the live session transcript)
- **Rate-limit / token pressure on scoring** → parallel batching + `Promise.allSettled` fault tolerance
- **SBIR API 403** → fall back to award data, **degrade visibly**, never silently
- **Embedding-dimension trap** → pin `text-embedding-3-small` @ **512-dim** everywhere (build + runtime)
- **Credits exhausted mid-build** → *"continue. I just bought the $200 max plan"* · **`:3001`** dev-port
  coordination between human and agent fleet

---

## Slide 15 — The authentic prompts that drove a fleet

**The human as director, not typist**

- *"read `START-HERE.md` and get to work"* — kick off the recon gate
- *"I want 5 subagents on sonnet, medium effort, each take two cases to review… divide up the cases and
  delegate"* — spawning a review fleet
- *"no don't mirror tasks into github issues… Merge all open PRs and lets move forward"*
- *"there is a CI failure with vercel: 'No Next.js version detected'…"*
- *"make sure all background agents are running and haven't hit usage limit stops"*
- *"the UI redesign hasn't landed — 60/30/10 official US gov hex codes… make a test branch, I want to A/B test it"*

---

## Slide 16 — Results & links

**21 PRs, all green, in a day**

- **21 merged PRs**; test counts climbed **33 → 62 → 70 → 88 → 95 → 122 → 177 → 185**, green at every merge
- **476** opportunities embedded @512-dim · **946** cited eligibility rules · golden set **31** cases (v1.0)
- Latency **~180s → ~98s** · **0 false exclusions** (24 checks + 160 determinations) · interview **4.1s** · **19/19** AA
- **Live demo:** https://your-app.example.com
- **Repo:** https://github.com/KurtLehnardt/granted
- **Orchestration spec:** https://github.com/KurtLehnardt/granted/blob/main/prompts/fundfinder-orchestrator-prompt.md
- **Recon docs:** [as-built](https://github.com/KurtLehnardt/granted/blob/main/as-built.md) ·
  [hypothesis-check](https://github.com/KurtLehnardt/granted/blob/main/hypothesis-check.md) ·
  [canon](https://github.com/KurtLehnardt/granted/blob/main/canon.md) ·
  [task-graph](https://github.com/KurtLehnardt/granted/blob/main/task-graph.md)
