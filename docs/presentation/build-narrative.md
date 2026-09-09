# fundFinder — How It Was Built (Build Narrative)

> Long-form source notes for the hackathon presentation. Every claim here is grounded in a
> repo artifact, a merged PR, or the authentic session transcript. Where a popular framing
> could not be verified against the repo, it is marked **[unverified]** and stated honestly.
>
> Project: **fundFinder** — a "government funding intelligence analyst" for founders.
> Built for the **GOED bounty at AI Builder Day, Aug 15 2026**. Hackathon prototype.
> Repo: `KurtLehnardt/fundFinder` · Live demo: https://your-app.example.com

---

## 1. The one-sentence story

A single **orchestrator agent** read a ~1,200-line spec, ran a recon pass that proved parts of
the spec wrong, decomposed the work into ~a dozen team-scoped task families, and then dispatched
**specialized dispatcher → worker subagent teams** that each built in an **isolated git worktree**,
opened **one PR per task**, were **reviewed by an opus critic**, and **auto-merged when clean** —
with many slices running **in parallel**. The result: **21 merged PRs in one ~8-hour session**,
test counts climbing 33 → 185 all green, shipping a calibrated federal-funding matcher whose
signature feature is the honesty to say *"there probably isn't a strong match."*

---

## 2. Problem & North Star

- **Problem:** founders don't know which federal grants/procurement programs fit them, and generic
  AI will confidently hallucinate five matches for any input.
- **North Star** (`northstar.md`): "make something that feels like a personal government funding
  intelligence analyst for every startup." Anchored on the *user* problem, not on finding uses for
  AI. Manage the **Intelligence / Cost / Latency** triangle with architectural model routing.
- **The product thesis** (`README.md`): *"Calibration is the product."* Any system returns five
  matches for any input; the differentiator is willingness to say *"probably not a fit"* and explain
  why. **Test case 5 (Youth Marketplace)** is the proof: a marketplace doesn't align with federal
  grant mechanics, and the system must decline instead of fabricating.

---

## 3. The build METHOD (this is the real story)

### 3.1 Two layers of instruction
- **How to operate** — `scaffold/docs/handoff.md` (the actual kickoff the human gave the agent):
  > "You are an orchestrator, not a worker… create dispatcher sub agents who you assign actionable
  > tasks to delegate, and the dispatchers spin up their own sub agents to actually do the work.
  > **These subagents must work in git worktrees.** When a subagent reports back… the dispatcher
  > will create a critical reviewer subagent to critique the code. Any critical or high findings
  > must be fixed… Please have a dispatcher create a new subagent to review all PRs and merge them
  > if no major issues are found."
- **Model/effort routing** (`handoff.md`): small→haiku, medium→sonnet, large→opus; **all critics and
  reviewers run as opus**; a subagent that trips a reviewer gets bumped to a higher effort/model tier.
- **What to build** — `prompts/fundfinder-orchestrator-prompt.md`, the ~1,200-line feature spec
  (§0 sequencing, §2 requirements, §3 contracts, §6 teams, §7 dependency graph, §8 rules, §9
  acceptance).

### 3.2 The rules that made parallelism safe
Quoted from the spec (§8):
- **One team owns each file.** "A subagent that needs to change a file outside its scope escalates
  rather than editing." (§8.1)
- **No self-merge.** "Review is by a different agent than the author, or by the orchestrator." (§8.5)
- **Contracts are frozen first.** "A team may not locally widen a shared type." (§8.1) Shared zod
  contracts (CON-01) shipped before any feature code.
- **Feature-flag everything.** "Every requirement ships behind a flag, defaulting off in production
  until its acceptance criteria pass." (§8.2)
- **Escalation is a success condition.** "Stopping to ask is a success condition, not a failure."
  (§8.3) — a formal 10-item stop list (legal/ToS exposure, unverifiable eligibility rules,
  prompt-injection-looking content, contract-schema changes).

### 3.3 Recon-before-build gate
`prompts/START-HERE.md` forced the orchestrator to **stop after recon and wait for human sign-off**
before writing a single task file: *"Do not write task files. Do not create GitHub issues. Do not
begin implementation."* Recon produced `as-built.md`, `hypothesis-check.md`, and `canon.md`.

**This gate paid off immediately.** `hypothesis-check.md` **refuted or reshaped 3 of the spec's 4
`[HYPOTHESIS]` markers** by reading the actual code:
- H1 "independent calls are serialized" → **refuted** (the real chain has a true data dependency).
- H3 "the pipeline is one big prompt" → **refuted** (it was already a composed chain).
- H4 "queries a live grant API per request" → **refuted, and the headline finding**: the app already
  read a *local pre-embedded corpus* with **no** government-API call on the request path. The real
  risk was not latency but **staleness** — the corpus never refreshed.

The orchestrator caught that the spec was solving a partly-wrong problem *before any code was written*,
and re-scoped the Canon and R4b slices accordingly.

### 3.4 Parallel slices — proven, not asserted
- Branch convention `v2/<team-task-slug>` = one subagent's isolated worktree.
- **PRs #7, #8, #9** (Eligibility, Interview, Frontend teams) merged within the **same minute**
  (2026-08-15 10:57–10:58 UTC). **PRs #12–#15** cluster at 11:33–11:34. Independent teams landing
  on `main` concurrently — the parallelism is visible directly in the PR merge log.

---

## 4. The decomposition (`task-graph.md`)

Tasks are markdown files (`tasks/*.md`), **not** GitHub Issues — an explicit owner decision
("no GitHub issues mirror," `task-graph.md:3`; also authentic prompt #15). ID convention:
`{TEAM}-{NN}-{slug}`.

| Prefix | Team | Scope |
|---|---|---|
| CON | Contracts | shared zod schemas, design tokens, feature flags, prompt registry, eval skeleton — ships first, blocks everyone |
| CAN | Canon | ingestion, normalization, cited eligibility-rule extraction, freshness, versioning |
| INT | Interview | pre-search question generation + answer merge |
| ELG | Eligibility | screening engine (3 buckets), freshness integration, tests |
| PIP / PRF | Pipeline / Perf | streaming + cancellation; latency/cost optimization |
| FE | Frontend | design system, interview/eligibility UI, progress UI |
| PLT | Platform | mock auth, no-retention, analytics |
| EVL | Evals | golden set + regression gates |
| VER / ITL / APL | Verify / Intel / Apply | later slices (R2/R5/R6) |

**Dependency waves:** Slice 1 = Contracts + Canon foundation (blocks all); Slice 2 = the rebuilt
entry flow (interview + eligibility + design + mock-auth); Slice 3 = progress + perf. Critical path:
`CON-01 → CAN-01 → CAN-04 → ELG-01 → INT-02/FE-03`. **Slices 1–3 shipped in the hackathon window;
Slices 4–8 exist as task specs but were not built** (planned, honest scope note).

---

## 5. Architecture (the request path)

Verified from `as-built.md` / `lib/*`:

1. **Interview (optional, R1)** — `generateQuestions()` on **gpt-4o-mini**, gate-first, median **4.1s**.
2. **Extract profile** — `extractProfile()` on **claude-sonnet-4-6**.
3. **Embed query** — OpenAI **text-embedding-3-small, 512-dim**.
4. **Retrieve** — cosine over the pre-embedded corpus. **Today this is an in-memory scan over
   `data/opportunities.json`.** The **Supabase Postgres + pgvector** store (schema + typed client +
   hybrid semantic/lexical query, HNSW index) is **built and tested but not yet wired into the live
   `/api/match` path** — `tasks/CAN-01-...:22` says *"Do NOT wire into `app/api/match/route.ts` yet."*
   Do not present pgvector as load-bearing. **No government API call on the request path** either way.
5. **Screen (R8)** — `screen()` → **eligible / conditionally-eligible / excluded / unknown** with a
   zero-false-exclusion guarantee.
6. **Score + explain** — `explainMatches()` on claude-sonnet-4-6, **parallel-batched** with
   `Promise.allSettled` over batches of 8.
7. **Honest weak-field finding** when nothing clears the bar (the case-5 path).

Corpus: **476 opportunities** (grants.gov), all embedded at 512-dim; **335** carry SBIR award history;
**946 cited eligibility rules** extracted into the Canon (PR #6). Golden set: **31 cases**, frozen at
**v1.0** (`sha256:f79c6e57…`).

---

## 6. The latency hurdle (verified numbers)

- The originally **deployed** experience was a multi-minute wait (~3 min) because the design implied
  live per-request work.
- **Root cause reframed by recon:** retrieval was *already* local/pre-embedded — the corpus is fetched
  **offline once** by `scripts/1-fetch.mjs` → normalized → embedded (512-dim) → committed as static
  JSON. So there is **no live gov-API call per search**. (The **Supabase pgvector** store is the
  intended production home for this corpus — schema-complete and tested — but is **not yet wired into
  the request path**; retrieval today is still the in-memory JSON cosine loop.)
- **The measured win came from parallel-batching the LLM scoring:** `explainMatches` went from serial
  to `Promise.allSettled` over batches of 8, cutting **novel-input latency from ~180s → ~98s**
  (`as-built.md:72`, PR #1). Precomputed/cached demo cases render **instantly**.
- **Honesty note:** the spec's R4b target (p95 ≤ 60s, TTFT < 10s) is the acceptance bar for Perf work
  (PRF-01..07) that was **not fully shipped** in the window. Streaming progress (PIP-01) *did* ship
  (PR #11, NDJSON milestones). So the honest claim is **~180s → ~98s + real streaming**, not "sub-60s."
- **The hybrid future:** keep local semantic retrieval + add scheduled ingestion + a **targeted live
  freshness check that hits the source only for surfaced opportunities** — fully-live-per-request was
  explicitly rejected as it "reintroduces multi-minute latency… and fails hard on source downtime"
  (`resolved-questions.md` §4.3; SBIR API is 403 today).

---

## 7. Honesty / anti-fabrication (the calibrated "no")

- **Calibration is the product** (`README.md`). Case 5 must decline, not fabricate.
- **Zero-false-exclusion as a schema-level guarantee, not just a test target** (PR #7, ELG-01): only a
  **reviewed** rule (verified / user-stated) can *exclude* a company. A **`model_inferred` rule can
  never gate** — it degrades to **`unknown`**. A zod `.parse()` backstop **throws** on any attempt to
  exclude on model-inferred grounds. **unknown → unknown**, never a false "no."
- **Proven, twice, on data:** the golden-set false-exclusion eval (`evals/false-exclusion-eval.mjs`,
  build-blocking, exit-0-required) → **0 false exclusions across 24 checks**; and a read-only
  integration test against the **real Supabase corpus** → **0 false exclusions across 160
  determinations** (40 opportunities × 4 profiles, PR #14). The harness proves it can trigger *real*
  exclusions on verified rules (not a vacuously-green suite), then correctly flips every one to
  `unknown` when the same rule is downgraded to `model_inferred`.
- **Quote-grounding + citations:** every asserted eligibility rule cites a published source (SBA Policy
  Directive / 13 CFR 121.702 / 2 CFR 25). The golden set was **citation-checked by the product owner**
  and labeled transparently as *"citation-checked by product owner, not a domain expert"*
  (`resolved-questions.md` §5.4).
- **Honest funding label** (PR #2): "median award to similar companies," never implying guaranteed
  funding.
- **The interview eval, told honestly** (EVL-03, PR #17): the two *code-level* regression checks
  (gate-first ordering; structured/routing-relevant answers) passed **31/31, zero violations**. The
  LLM-judge "did it re-ask a stated fact?" check reported a noisy 6.5% headline that the results doc
  itself flags as inflated by judge false positives — so it was *not* treated as a quality score. A
  manual audit narrowed it to **1 confirmed genuine re-ask bug** (the interview re-asked a US-ownership
  gate after the founder said "70% foreign-owned"), fixed one PR later by bumping the registered prompt
  v1→v2 (PR #19). The eval — and honest reading of it — caught the bug, not a human.

---

## 8. Mocking what needs government approval

Real **auto-apply / system-to-system submission** to a federal portal requires the *founder's* active
**SAM.gov registration + UEI**, an authorized **AOR**, and **E-Biz POC** delegation, plus approved
government API access — and **fundFinder cannot legally be the applicant's AOR/E-Biz POC**.

- **APL-01** (`tasks/APL-01-s2s-feasibility-memo.md`) required a **research-only feasibility memo,
  gated on legal review, before any code** — explicit non-goal: headless-browser submission to any
  federal portal. Output: `docs/R6-s2s-feasibility-memo.md`.
- **FE-06** shipped the "Auto-Apply" feature as a **UI-only stub**: a padlock + "Pro subscription"
  modal that **never submits anything, gates nothing server-side**, framed as *"waiting on grant-site
  API keys / admin review."* Honest about being a placeholder awaiting approval
  (`open-questions.md`, "FE-06 Auto Apply stub"; PR #18).
- Settings collects the **founder's own** SAM/UEI/AOR facts (their credentials, not fundFinder's) — the
  correct framing.

---

## 9. Key features

- **Pre-search interview (R1):** gate-first clarifying questions on gpt-4o-mini before the expensive pass.
- **Eligibility screening (R8):** three honest buckets + `unknown`, with the zero-false-exclusion guarantee.
- **Government Opportunity Map (R3):** ranked matches, each with why-fit / why-ineligible / what-to-verify /
  what-to-do-next, plus similar-company award history.
- **Freshness annotation (R8.3):** flags stale determinations rather than showing closed grants as open.
- **Streaming progress (R4):** NDJSON milestones + hybrid progress bar (PR #11), replacing the static
  "Reading the federal register…" label.
- **USWDS design system (R7):** 60/30/10 official-government palette (navy #005ea2, green CTA #538200),
  **19 contrast pairings pass WCAG AA** (PR #9), behind the `r7_design` flag.
- **Mock auth + local-only persistence (R9.0):** client-only sign-in, consent + delete-my-data, **no
  server-side retention** — proven by an automated regression test (PR #12).
- **Typed analytics (R10.1):** `track()` + 19 funnel events, flag-gated (PR #15).
- **/demo route** and 5 precomputed judged cases that render instantly (wifi-proof for the demo).

---

## 10. Design decisions & tradeoffs

| Decision | Rationale |
|---|---|
| **Supabase Postgres + pgvector** for the corpus (not a flat file) | supports hybrid keyword+semantic retrieval + versioning; owner wired the Supabase MCP mid-session (`resolved-questions.md` V-E) |
| **Hybrid ingestion**, not fully-live-per-request | fully-live "reintroduces multi-minute latency… and fails hard on source downtime" (SBIR 403) — §4.3 |
| **localStorage for user data, nothing retained server-side** | descriptions/consent stay client-side pre-accounts; server proven retention-free by test (PR #12) |
| **No GitHub Issues** — `tasks/*.md` is the system of record | owner decision; avoids duplicate tracking during a fast build (authentic prompt #15) |
| **Golden set frozen at v1.0**, owner citation-check | owner had no SBIR expertise; citation-check + transparent labeling instead of expert rating |
| **Zero-false-exclusion by construction** | defense-in-depth: reviewed-only rules gate, `.parse()` backstop, `model_inferred` → `unknown` |
| **Feature-flag everything, default off** | one-flag revert if a slice regresses; R7/R1/R8 stay OFF pending a **§9.1 human validation session** |
| **R4b re-scoped after recon** | two of four original hypotheses were refuted — building them would have solved a non-problem |
| **R6 auto-apply = UI-only stub** | real submission is legally fraught; ship the honest placeholder, defer the real thing to counsel |

---

## 11. Hurdles overcome

- **Vercel "No Next.js version detected"** — the app lives in `scaffold/`, not repo root, so Vercel
  couldn't find `package.json`. **Verified first-hand** via authentic session prompt #4 ("there is CI
  failure with vercel, it says 'No Next.js version detected… check your Root Directory'"); fixed by
  setting **Vercel Root Directory = `scaffold/`** (`as-built.md`).
- **Provider rate-limit / token-budget pressure on the scoring calls** — addressed by parallel-batching
  `explainMatches` and making it fault-tolerant with `Promise.allSettled` so one bad batch no longer
  500s the request (PR #1, PR #2). *(The literal "429" HTTP code isn't named verbatim in PR bodies;
  the batching fix is confirmed — [unverified] on the exact error string.)*
- **SBIR solicitations API returning 403** — handled by falling back to SBIR *awards* data and degrading
  **visibly** per the source-failure policy (§4.6), never silently.
- **Embedding-dimension mismatch risk** — build-time (`scripts/3-embed.mjs`) and runtime (`lib/embed.ts`)
  had to use identical model + `dimensions: 512`, done as Task 1 to avoid garbage cosine similarity.
- **v1 Anthropic credits exhausted mid-build** — live path degraded to 500s until top-up; the 5
  precomputed cases + `/demo` kept working (authentic prompts #19, #23 — "I just bought the $200 max plan").
- **File-lock collisions between concurrent teams** — PLT-01 (mock auth) and FE-01 (design tokens) both
  touched `app/page.tsx`; PR #10 was "merged last with a hand-reconcile onto FE-01's token classes" —
  the file-ownership rule enforced via merge ordering.
- **`:3001` dev-port coordination** — the human tested on `:3001` (authentic prompt #2's curl; PR #18
  notes a live server on `:3001`) — a recurring human↔agent coordination point.
- **Supabase IPv6-only pooler gotcha** — connect via the pooler in region `aws-0-us-west-2`.
  *([unverified] from in-repo artifacts; consistent with the project's known environment notes.)*

---

## 12. Results / metrics (verifiable)

- **21 merged PRs** in one session (2026-08-15, ~05:42–13:50 UTC).
- **~20 task slices** shipped across Slices 1–3 of the 8-slice graph.
- **Test counts, all green at every merge:** 33 → 62 → 70 → 88 → 95 → 122 → 177 → **185**.
- **Corpus:** 476 opportunities embedded @512-dim; 335 with award history; **946 cited eligibility rules**.
- **Golden set:** 31 cases, frozen v1.0 (`sha256:f79c6e57…`).
- **Latency:** novel input **~180s → ~98s** (parallel scoring); cached cases instant; streaming shipped.
- **Zero false exclusions:** 0 across 24 golden-set checks (build-blocking eval) **and** 0 across 160
  live determinations.
- **Interview latency:** median **4.1s** (< 5s target).
- **Accessibility:** **19/19** color pairings pass WCAG AA.

---

## 13. The authentic prompts that drove it

Real, human-typed prompts from the build session (`f2007485-…jsonl`), showing the human as a
high-leverage director of an agent fleet:

- *"read `START-HERE.md` and get to work"* — kick off the recon gate.
- *"I want 5 subagents running on sonnet on medium effort to each take two of the cases to review…
  divide up the cases and delegate the work to them"* — spawning a review fleet.
- *"no don't mirror tasks into github issues… Merge all open PRs and lets move forward."*
- *"there is a CI failure with vercel, it says 'No Next.js version detected'…"* — the deploy hurdle.
- *"make sure all background agents are running and haven't hit usage limit stops. Have them continue."*
- *"continue. I just bought the $200 max plan."* — unblocking the fleet.
- *"the UI color redesign hasn't landed. I asked for a 60/30/10 color rule pallet using official US
  government color hex codes… make a test branch before pushing it to main, I want to A/B test it."*

---

## 14. Links

- **Live demo:** https://your-app.example.com
- **Repo:** https://github.com/KurtLehnardt/granted
- **Orchestration spec:** https://github.com/KurtLehnardt/granted/blob/main/prompts/fundfinder-orchestrator-prompt.md
- **Entry point:** https://github.com/KurtLehnardt/granted/blob/main/prompts/START-HERE.md
- **Recon — as-built:** https://github.com/KurtLehnardt/granted/blob/main/as-built.md
- **Recon — hypothesis check:** https://github.com/KurtLehnardt/granted/blob/main/hypothesis-check.md
- **Recon — canon (data sources):** https://github.com/KurtLehnardt/granted/blob/main/canon.md
- **Task graph:** https://github.com/KurtLehnardt/granted/blob/main/task-graph.md
- **R6 assisted-apply feasibility memo:** https://github.com/KurtLehnardt/granted/blob/main/docs/R6-s2s-feasibility-memo.md
