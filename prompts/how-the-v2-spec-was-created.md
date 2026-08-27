# How the v2 spec was created

A reconstruction of where `prompts/fundfinder-orchestrator-prompt.md` — the 1,210-line
"Interview-First Opportunity Map" spec — came from, and how the surrounding v2 planning
was done.

This document is built from primary sources: the session transcript
(`~/.claude/projects/-Users-LenovoT440p-work-fundFinder/f2007485-…​.jsonl`, ~39 MB / ~14k
lines), the committed repo (`git show origin/main:…​`), and the retrospective docs that
already narrate the build (`docs/presentation/build-narrative.md`,
`retrospective/granted-retrospective-vol2.md`, `retrospective/user-prompt-arc.md`).

Timestamps are quoted as they appear in the transcript, which records them in **UTC**. The
product owner works in Mountain time, so subtract ~6–7 hours to get local wall-clock (a
`02:57Z` prompt is a late-evening prompt for them).

**A note on honesty, up front.** The transcripts we have do **not** capture the 1,210-line
spec file being drafted. By the time the orchestrator first reads it, it already exists on
disk as a finished 74,954-byte file. What the record *does* capture, in full, is the same
author → critique → refine method applied to two *sibling* planning artifacts —
`gap-closure-plan.md` and `docs/s2s-integration-spec.md` — on the following day. Where this
document describes that loop concretely, it is quoting real turns. Where it talks about the
drafting of the orchestrator prompt itself, it is inferring from surrounding evidence and
says so. Section 9 is the explicit list of what could and could not be reconstructed.

---

## 1. TL;DR

- The 1,210-line spec is a **product-owner artifact**. It entered the v2 build as a
  pre-written input file that the orchestrator was told to *read*, not to *author*. It was
  committed to the repo on 2026‑08‑15 (PR #25) and never substantively edited afterward
  (only a `fundFinder → granted` URL rename). Its own drafting sessions are not in the
  captured transcripts.
- The spec was the product owner's response to gaps found **after v1 (the hackathon MVP)
  shipped**: a 3‑minute wait with no feedback, clarifying questions asked *after* the
  expensive search instead of before, a static grants‑only corpus, and no guaranteed
  relevance/eligibility floor. Its §1 "Problem statement (from the product owner)" is
  essentially that gap analysis written down.
- The **author → critique → refine pipeline** the project is known for is real and fully
  captured — but for the *execution plan* that operationalized the spec: `gap-closure-plan.md`,
  authored 2026‑08‑16 under the direction of the pivotal prompt "*Plan it as opus on xhigh
  effort, then critique the plan with an opus xhigh subagent and refine it again until it
  meets all criteria and stretch goals.*" That plan went through **two opus/extra‑high
  critique cycles** (v1 → v2 → v3), re‑benchmarked against the live hackathon brief each
  cycle.
- A third artifact, the grants.gov **S2S integration spec** (`docs/s2s-integration-spec.md`),
  was produced later the same day by an **architect agent (opus/xhigh) using the product
  owner's `/build` skill** — this is the "refine it several times until we have a well
  defined spec sheet for spec‑driven development" step.
- Net: the orchestrator prompt is a hand-authored spec; the *method* the task attributes to
  it (opus author, opus critic, refine against the brief) is genuinely how the product owner
  worked, and we can prove it on the planning docs that surround the spec.

---

## 2. Genesis — v1 and the operating model it established

The project began not from a chat but from a written directive:
`scaffold/docs/handoff.md`. That file set the operating model that everything downstream
inherited. In the product owner's own words:

> "You are an orchestrator, not a worker. You will accomplish the tasks described in this
> prompt by creating dispatcher sub agents who you assign actionable tasks to delegate, and
> the dispatchers spin up their own sub agents to actually do the work. These subagents must
> work in git worktrees. When a subagent reports back to the dispatcher that it's work task
> is completed, then the dispatcher will create a critical reviewer subagent to critique the
> code."

Handoff.md also fixed the model/effort routing that recurs through the whole build: "a small
effort can be handled by haiku, a medium effort by sonnet, and a large effort by opus … All
critics and reviewers must be run as opus … If a reviewer finds many issues … the subagent
must be moved to a higher effort tier (up to xhigh) or a higher model (up to opus)."

The target was the GOED "Government Opportunity Finder" bounty at AI Builder Day, judged
2026‑08‑15 at 2:00 PM. The brief (`scaffold/docs/bounty.md`) is worth reading because the
spec is, in effect, a second pass at satisfying it. Its rubric — Usefulness 30%, Quality of
Matching 25%, Intelligence & Insight 20%, UX 15%, Technical Execution 10% — and its core
thesis ("the differentiating behavior is willingness to say 'there probably isn't a strong
match'") are the constraints both v1 and v2 were built against.

v1 shipped inside the primary transcript. That session opens 2026‑08‑15 01:17Z with "*we
were working on a project in ~/work/fundFinder … Please read … handoff.md and lets get going
on the work*," and by 05:59Z the orchestrator reports the demo is "production‑ready right
now — you have a shareable public URL where all five judged cases work instantly." v1 is the
calibrated honest‑no MVP: a founder's plain‑English description → federal grant matches,
with the willingness to return near‑empty and explain why.

---

## 3. Why a v2 spec — the gaps after v1

Once v1 worked, re‑reading the brief exposed how much of the *product* was still missing.
`retrospective/granted-retrospective-vol2.md` lists the gaps plainly:

> - Corpus was **grants-only** (476 opportunities). No R&D, procurement, loans, assistance,
>   scholarships.
> - No **structured questionnaire**; no *"why should I care about this?"*
> - Matching felt **over-generous**: a wall of amber "verify" maybes.
> - No path to actually **fill out** a high-matching grant.

The spec's own §1, "Problem statement (from the product owner)," is the same list seen from
the UX side. It is the clearest statement of *why* v2 exists, so it is worth quoting at
length:

> "The current flow takes a free-text company description, runs one expensive LLM + API
> pass, and returns a Government Opportunity Map after **~3 minutes of dead air**. The output
> *ends* with the questions that would have made it better … The core insight: **the
> refinement questions are worth more before the search than after it.** Ask cheap questions
> first, spend tokens second."

It then enumerates the problems by name: **sequencing** (clarify before the expensive op,
not after), **dead ends** (verification items handed to the user as homework), **dead air**
(3 minutes, no feedback), **affordance** (the sector buttons read as filters on your
business, not as sample companies), and a **relevance floor** ("nothing currently guarantees
the surfaced programs are ones the company can actually apply for, or that are still open").

So the spec is a v1 → v2 gap document turned into a build order. It was authored *after* v1,
in response to v1, by the product owner.

---

## 4. The method: author → critique → refine

This is the section the task most wants, and it needs a precise framing: **the fully
documented instance of author → critique → refine in the transcripts is the
`gap-closure-plan.md` loop of 2026‑08‑16, not the drafting of the orchestrator prompt.** The
orchestrator prompt had already been written and handed over the day before. What follows is
the real, captured pipeline — it is the best direct evidence we have of how the product owner
directs spec/plan authoring, and it is the pattern the retrospective decks generalize into
"the plan was itself a subagent pipeline."

### 4.1 The pivotal prompt (2026‑08‑16 02:57:59Z)

Verbatim (trimmed only where noted):

> "ok lets refine a plan to address all missed things and gaps. **Plan it as opus on xhigh
> effort, then critique the plan with an opus xhigh subagent and refine it again until it
> meets all criteria and stretch goals.**
> There should also be a more thourough questionaire at the beginning, asking for Company
> description / Industry / Technology / Location / Employees / Revenue / Funding stage /
> Capital raised / R&D activities / Product maturity / Target customers / Capital
> requirements / Use of funds, to better understand the company, instead of asking for some
> random sentences about it.
> Every recommendation should answer: why should I care about this? The system should never
> present an AI-generated assessment as a definitive determination of eligibility.
> Lets refer back to https://startupstate-hackathon-brief.lovable.app/ between every review
> cycle of the plan to see if there is anything else we missed … I want there to be well
> refined plans of action items and tasks that can be digested by teams of subagents and
> turned into PRs."

Three things this prompt did: (1) named the exact author/critic loop and effort tier; (2)
introduced the **13‑field structured questionnaire** (note: this list is *not* in the
1,210‑line spec — the spec's R1 asked for a "3–5 question" adaptive interview; the 13 fields
trace to the bounty brief's own INTAKE list and were formalized here); and (3) fixed the
"re‑benchmark against the live brief between every cycle" rule.

### 4.2 The author

One accuracy correction to the received story: the plan's **v1 was written by the
orchestrator itself**, not by a delegated subagent. At 02:59:03Z the orchestrator says "Let
me author a rigorous v1 first," and at 03:00:20Z it writes `docs/gap-closure-plan.md`
directly with the `Write` tool (status line in the file: "*v1 (authored by orchestrator) —
pending opus …*"). The "opus on xhigh effort" instruction was satisfied by the orchestrator
being that model; the *delegated* opus/xhigh agents in this loop were the **critics**.

### 4.3 The critic (opus, extra‑high effort)

At 03:00:58Z the orchestrator dispatched an `Agent` (subagent_type `general-purpose`, model
`opus`, described "Opus xhigh plan critic"). Its instructions are quoted here because they
show the method exactly:

> "You are an EXACTING plan critic. Reason at MAXIMUM depth and rigor (the user explicitly
> asked for opus at extra-high effort) … Do NOT rewrite the whole plan; return targeted
> findings + a verdict.
> ## INPUTS 1. The plan … 2. The AUTHORITATIVE brief: WebFetch
> `https://startupstate-hackathon-brief.lovable.app/` — extract EVERY requirement … the
> judging criteria WITH WEIGHTS … 3. The real codebase … spot-check the plan's 'built today'
> claims and file paths for accuracy."

### 4.4 The critique's real findings (returned 03:07:48Z)

The critic came back via an inter‑agent message. Its reframe is the single most‑cited moment
in the project's lore, and it was correct on the substance: the plan's "built today" file
paths did not describe the checkout the critic was reading.

> "Big reframe first: the plan's 'built today (verified)' section and file paths do NOT match
> `/scaffold` (that's `main` = v1). They match the **`v2/fe-slice2`** branch. I verified:
> `lib/eligibility/screen.ts` (real R8.4 engine, schema `.parse()` throws on model-inferred
> `excluded`), `lib/flags/registry.ts` (flags default-OFF, requirement-gated),
> `lib/contracts/*` (Zod), `lib/interview/*`, `lib/prompts/registry.ts` … five gates as npm
> scripts … and `maxDuration=120` — ALL exist on v2, NONE on main. So the plan is not
> hallucinating; it's just silent about its baseline. That silence is the top risk."

It then issued graded findings — five **CRITICAL** (C1–C5), seven **IMPORTANT** (I1–I7),
five **NICE-TO-HAVE** (N1–N5) — and a **VERDICT: "As written, NO."** The critical five, in
its own compression:

- **C1** — declare the baseline branch; a worker told to "extend screen.ts" off `main` would
  fail because the file isn't there.
- **C2** — reconcile the deadline against a ~30‑task roadmap; provide a ruthless MVP cut.
- **C3** — flags default‑OFF plus no "flip the flags / re‑precompute the demo" task means
  "judges may see ZERO new behavior."
- **C4** — an anti‑fabrication landmine: the "Similar companies funded" award rows must each
  trace to a real record "before demo," or the product fabricates the exact thing it promises
  never to.
- **C5** — new sources may never *surface*: a fixed top‑24 cosine cut over a grants‑dominated
  corpus can crowd out the lone SBIR/procurement opp a test case requires. Add per‑resource‑
  type retrieval quotas.

The orchestrator then did something notable for honesty: it **checked the critic before
trusting it**. It verified C1 against the real `origin/main` and found the critic had read a
*stale local `/scaffold` checkout* — the v2 infra was in fact already on `origin/main @
e575e3a`. So the fix wasn't "add a land‑v2 task" but "declare the baseline so workers branch
from `origin/main`." C4 (awards provenance) it accepted outright as a hard gate. That
verify‑the‑critique step is the loop working as designed, not rubber‑stamping.

### 4.5 The refine‑against‑the‑brief loop

- **v2** was written at 03:11:32Z ("*refined after opus/xhigh critique cycle 1*"), addressing
  all seven must‑fixes plus the importants.
- A **second** opus/xhigh critic was dispatched at 03:12:08Z — this time explicitly pointed
  at the *correct* tree ("The local `…/scaffold` is a STALE, un-synced checkout (v1) — do NOT
  judge 'what's built' from it … Cycle 1 wrongly concluded 'main lacks the v2 infra'").
- Between cycles the product owner steered again (03:16:45Z): "*lets do one more review
  cycle, and then lets fan out … I want PRs created and this volume of work moved forward
  until a business owner can have high matching grants fully filled out on their behalf with
  this tool.*" That sentence created a whole new workstream — **WS‑G, Application Generation
  & Assisted Filing** — which the orchestrator added to the plan at 03:18:37Z.
- Cycle 2 returned **"APPROVE-WITH-FIXES"** (four refinements, no new workstreams; the
  important one was a taxonomy collision — extend the existing `kind` enum with
  `loan`/`scholarship`, don't invent a parallel `resourceType`). The orchestrator applied
  them and the plan **converged to v3** at ~03:22Z, then fanned out Wave 0.

---

## 5. The rounds — how many are actually captured

For the **1,210-line orchestrator prompt**: *zero* drafting rounds are in the transcripts.
It arrives finished. The only internal hint that it had a revision history before hand‑off is
kickoff.md's own note that "15 `[DECIDE]` markers remain in the spec. Three are already
resolved and marked `DECIDED` (auth approach, pre‑R9 retention, consent)" — i.e. someone had
already made a pass resolving decisions — but the passes themselves are not recorded.

For the **`gap-closure-plan.md`** (the documented loop): **two critique cycles**, producing
**three plan versions**:

| Round | What happened | Transcript time (UTC) |
|---|---|---|
| v1 | Orchestrator authors the plan directly (`Write`) | 2026‑08‑16 03:00:20 |
| Critique cycle 1 | Opus/xhigh critic → VERDICT "NO", 5 CRITICAL / 7 IMPORTANT / 5 NICE | 03:07:48 |
| v2 | Refined against all seven must‑fixes; baseline declared | 03:11:32 |
| (steer) | Owner adds the "fill out grants on their behalf" north star → WS‑G added | 03:16–03:18 |
| Critique cycle 2 | Opus/xhigh critic (correct tree) → "APPROVE‑WITH‑FIXES", 4 refinements | ~03:20 |
| v3 | Four fixes applied (taxonomy collision the key one); plan converged | ~03:22 |

For the **S2S integration spec**: the `/build` architect ran its own "refine it several
times" loop inside a background agent; the transcript shows the *instruction* to do so and
the *result* (`docs/s2s-integration-spec.md` finished at ~14:40Z, "*The S2S architect
finished its spec*"), but the individual refine iterations happened inside that agent and are
not itemized in the main transcript. So: instruction and outcome captured, per‑iteration
detail **not captured**.

---

## 6. What the finished spec contained

The committed spec (`prompts/fundfinder-orchestrator-prompt.md`, 1,210 lines) is organized as
§0 through §11. Its own header tells the reader how to use it: "*Paste everything below into
the orchestrator agent. It is written to be decomposed into workstreams and delegated to
subagent teams.*"

- **§0 — Your job as orchestrator.** Inputs (§0.1), a six‑step **sequence** (§0.2: recon
  first → reconcile against the as‑built → decompose → assign → freeze contracts → gate
  merges), deliverables (§0.3), and a task template (§0.4).
- **§1 — Problem statement** (quoted in §3 above).
- **§2 — Requirements R1–R10.** R1 pre‑search interview (highest priority; "*3–5 targeted
  questions*," gate‑resolving questions prioritized over ranking, small/fast model, skippable
  in one click); R2 "Verify these for me" (triage into `auto_verifiable` / `user_only` /
  `judgment`, conservative classifier); R3 "Enhance my company description"; R4 real progress
  ("*no fake progress: every emitted event corresponds to a real backend transition*"); R4b
  latency/cost budgets (p95 ≤ 60s target, TTFT < 10s); R5 competitor/peer intelligence
  (Pro); R6 assisted application (Pro, thin slice); R7 design system + landing corrections;
  R8 eligibility & freshness screening; R9 accounts/persistence/billing; R10 analytics,
  prompt versioning, observability.
- **§3 — Shared contracts, defined FIRST.** Twelve typed schemas that no team may write
  feature code before landing: `CompanyProfile` (with **mandatory provenance** per field —
  `user_stated | model_inferred | verified`), `ProgressEvent`, `VerificationItem`,
  `Opportunity`, `EligibilityDetermination`, `OpportunityMap`, `Entitlements`, **design
  tokens**, a **model routing table**, `RunBudget`, `AnalyticsEvent` (schema‑level guarantee
  that free‑text description content can't be attached), and `Run`.
- **§4 — The Canon.** The data foundation: establish what exists, sources & coverage,
  ingestion, freshness, retrieval, source‑failure behavior. Flagged as the thing to resolve
  first because "*the current prompt … would otherwise optimize a pipeline whose data source
  is undefined.*"
- **§5 — Guardrails, budgets, policy.** Input bounds, a cost ceiling, data handling, a golden‑
  set specification, untrusted‑content rules, secrets/env.
- **§6 — Subagent teams**, **§7 — dependency graph and ship order** (Contracts + Canon → R7 +
  R1 + R8 + R10.1 → R4 + R4b → R2 → R3 → R9 → R5 → R6, with "*Prefer shipping slices 1–3 well
  over shipping all ten half‑built*").
- **§8 — Working agreements** (integration protocol, feature flags/rollback, a 10‑item
  escalation stop list, testing, review), **§9 — acceptance criteria** (per‑requirement, "*enforced
  at merge*," including required human‑validation sessions in §9.1), **§10 — non‑goals**, and
  **§11 — standing constraints** ("*Calibration beats confidence … Never let a model inference
  wear the costume of a verified fact*" / "*Silence is worse than a gap*").

**The `[HYPOTHESIS]` and `[DECIDE]` markers.** These are the spec's most distinctive device
and its own honesty mechanism, explained in the preamble:

> "items marked `[DECIDE]` are product-owner calls that this prompt deliberately does not make
> for you … Items marked `[HYPOTHESIS]` are claims about the current system inferred from
> symptoms rather than read from code — the orchestrator confirms or kills each one during
> recon."

There are ~15 `[DECIDE]` markers (kickoff.md's count; three pre‑resolved) and four real
`[HYPOTHESIS]` markers (at spec lines 268, 277, 281, 769). The recon gate existed precisely to
test them — and it paid off: `hypothesis-check.md` **refuted or reshaped three of the four**,
most importantly H4 ("queries a live grant API per request"), which was wrong — the app read a
local pre‑embedded corpus with no request‑path government call, so the real risk was
staleness, not latency. The spec was, in the retrospective's words, "solving a partly‑wrong
problem," and the markers are what let the orchestrator catch that before writing code.

---

## 7. From spec to build

The spec did not run itself. Three files staged the hand‑off, and the transcript shows the
orchestrator moving through them in order.

1. **`kickoff.md`** (present in the transcript at 2026‑08‑15 07:05Z; never committed to
   `main`). A "meta" file — "*This is the message you actually send to start the
   orchestrator. Everything else lives in the repo, so you're pointing at files rather than
   pasting a spec every time.*" It carries the literal kickoff message ("*Read
   `docs/orchestrator-prompt.md` in full … Follow the sequence in §0.2. Start with recon …
   then stop and present them for review*"), the ship‑order reminder, and the open‑decisions
   list. Its file map pointed at `docs/orchestrator-prompt.md` and a `docs/mock-auth/`
   directory that did not exist; the actual file was at `prompts/fundfinder-orchestrator-prompt.md`
   and only the mock‑auth README was present. The orchestrator flagged both path mismatches
   rather than reconstructing the missing input — exactly the behavior START‑HERE demanded.
2. **`START-HERE.md`** (the entry point the owner ultimately used: "*actually, read …
   START-HERE.md and get to work*," 07:14Z). It scoped the first move to **Phase 1: recon
   only** — produce `as-built.md`, `hypothesis-check.md`, `canon.md` "*and nothing else*,"
   then **stop and wait for human review**: "*Do not write task files. Do not create GitHub
   issues. Do not begin implementation.*" Its rationale is the recurring theme: "*Everything
   downstream inherits errors in these three documents.*"
3. **Recon** produced the three documents against the real code (`origin/main @ aa3297f`),
   with the static‑corpus/freshness finding as the headline of `canon.md`.
4. **Delegated workstreams.** From there the orchestrator fanned out into the
   dispatcher → worker pattern — one team per file, PR‑per‑task, opus review, central merge —
   the operating model handoff.md had set. The `gap-closure-plan.md` loop of the next day
   (Section 4) was the same machinery pointed at *planning*: "*the same orchestrator →
   dispatcher → worker pattern that built the app also planned it*"
   (`granted-retrospective-vol2.md`).

The spec, START‑HERE.md, and the mock‑auth bundle were then swept into the repo on
2026‑08‑15 by **PR #25** (commit `7eaa82f`, "*docs(presentation): hackathon deck*"), whose
message is candid that these were local files being committed for the first time: "*commits
the source material the deck's GitHub links resolve to, since these were not on origin/main:
prompts/ (orchestrator spec, START-HERE, mock-auth bundle), the recon docs … and the task
specs.*" That is the moment the spec became a versioned repo artifact.

---

## 8. Timeline of the key events

All times UTC, from the primary transcript unless a commit is named.

- **2026‑08‑15 01:17** — Session opens; v1 build continues from `handoff.md`.
- **2026‑08‑15 ~05:59** — v1 reported "production‑ready," five judged cases live on a public URL.
- **2026‑08‑15 07:05** — Owner: "*here is the next prompt: prompts/kickoff.md … read it and
  get to work.*" The **1,210-line spec already exists on disk** (74,954 bytes) and is read
  here for the first time.
- **2026‑08‑15 07:14** — Owner redirects to `START-HERE.md`; Phase‑1 recon begins.
- **2026‑08‑15 07:20–07:22** — Recon deliverables written (`as-built.md`,
  `hypothesis-check.md`, `canon.md`); H4 refuted, staleness identified as the real risk.
- **2026‑08‑15 08:06 (MST)** — **PR #25 / commit `7eaa82f`** commits the spec, START‑HERE,
  mock‑auth bundle, recon docs, and the presentation deck to `main`.
- **2026‑08‑16 02:57:59** — **Pivotal prompt**: "*Plan it as opus on xhigh effort, then
  critique the plan with an opus xhigh subagent and refine it again …*," plus the 13‑field
  questionnaire and "why should I care" requirement.
- **2026‑08‑16 03:00** — Orchestrator authors `gap-closure-plan.md` v1.
- **2026‑08‑16 03:07** — Opus/xhigh critic returns the v2/fe‑slice2 baseline reframe; verdict "NO."
- **2026‑08‑16 03:11** — Plan v2 written.
- **2026‑08‑16 03:16–03:18** — Owner adds the "fill out grants on their behalf" north star; WS‑G added.
- **2026‑08‑16 ~03:20–03:22** — Cycle‑2 critic → "APPROVE‑WITH‑FIXES"; plan converges to v3; Wave 0 fans out.
- **2026‑08‑16 14:20** — Owner: "*… spin up an architect agent running opus on xhigh to use my
  `/build` skill to create specifications … refine it several times … ensuring parity with*
  the brief." → the **S2S integration spec**.
- **2026‑08‑16 14:23–14:27** — Owner pivots to the **Chrome auto‑fill extension** idea ("*a
  better idea than the S2S API for most cases*"); a recon‑first extension team launches.
- **2026‑08‑16 ~14:40** — `docs/s2s-integration-spec.md` finished by the architect agent.
- **2026‑08‑16 22:03 (commit `580bf6d`)** — The spec's only later edit: `fundFinder → granted`
  URL rename.

---

## 9. What we could and couldn't reconstruct

**Solidly reconstructed (primary‑source quotes exist):**

- That the 1,210-line spec entered the build as a **pre‑existing file**, read on 2026‑08‑15
  07:06Z, present on disk before the session touched it, committed unchanged via PR #25, and
  never substantively edited (git history shows exactly two commits: the add and a URL
  rename).
- The spec's full §0–§11 structure, its 12 contracts, its R1–R10 requirements, its
  `[HYPOTHESIS]`/`[DECIDE]` mechanism, and how recon tested the hypotheses.
- The complete `gap-closure-plan.md` author → critique → refine loop: the pivotal prompt, the
  critic's dispatch prompt, the verbatim critique (C1–C5 / I1–I7 / N1–N5 / verdict), the
  orchestrator's verification of the critique, and the two‑cycle convergence to v3.
- The `/build` architect instruction that produced the S2S integration spec, and the Chrome‑
  extension pivot.

**Could not reconstruct (honest gaps):**

- **The drafting of the orchestrator prompt itself.** No transcript in this project's session
  store contains it being written. The other sessions were checked: two are seconds‑long false
  starts, one is the v1 build (same opening prompt, ends 04:44Z on 08‑15), one is an unrelated
  "create Claude skills" session (08‑16→08‑17), one is a `remotion` install. None contain the
  string "Interview-First Opportunity Map" or author the file. It appears to have been written
  in a session or by a hand that these transcripts do not preserve. Whether *it* went through
  its own opus‑critique loop is unknown; the only trace of prior revision is kickoff.md's note
  that three `[DECIDE]` markers were already resolved before hand‑off.
- **The per‑iteration detail of the S2S `/build` refinements.** Those happened inside a
  background architect agent; the main transcript records the instruction and the finished
  output, not each "refine several times" pass.
- **Exact authorship of the 13‑field questionnaire's final field list.** The list is dictated
  in the 02:57Z prompt and matches the bounty brief's INTAKE section; it is not in the
  1,210‑line spec. Which of those two is the true origin (versus simple restatement) is not
  separable from the record.

**One correction to the received story.** The `gap-closure-plan.md` **v1 was authored by the
orchestrator directly**, not by a delegated opus/xhigh subagent (the file's own status line
says "authored by orchestrator"); the delegated opus/xhigh agents in that loop were the
**critics**. The "plan it as opus on xhigh" instruction was met by the orchestrator being
that model, and the author → critique → refine framing is accurate — with the author being
the main agent, not a sub‑agent.

---

*Compiled from the session transcript and committed repo artifacts. Quotes are verbatim
(trimmed where marked with … for length); paraphrase is labeled as such.*
