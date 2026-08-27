---
marp: true
paginate: true
size: 16:9
title: "Granted — Build Retrospective · Volume 2"
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
---

<!-- _class: lead -->

# Granted: Retrospective
## Volume 2 · From "it works" to "it's honest, and it ships"

<span class="small">Orchestrator → dispatcher → worker subagents · PR-per-task · central merge · everything grounded or gated</span>

---

## Where Volume 1 left off

- **v1 shipped**: a founder's plain-English description → federal grant matches, with a calibrated *honest no*.
- Then we re-read the **hackathon brief** and found real gaps:
  - Corpus was **grants-only** (476 opportunities). No R&D, procurement, loans, assistance, scholarships.
  - No **structured questionnaire**; no *"why should I care about this?"*
  - Matching felt **over-generous**: a wall of amber "verify" maybes.
  - No path to actually **fill out** a high-matching grant.
- Volume 2 is closing those gaps, **without ever compromising the honesty contract.**

---

## The plan was itself a subagent pipeline

1. **Author** the gap-closure plan as *opus · extra-high effort*.
2. **Critique** it with a *second opus · xhigh* subagent.
3. **Refine** against the live brief between every cycle, until it met all criteria + stretch goals.
4. Break it into **team-digestible workstreams** (WS-A … WS-G) → fan out to dispatcher/worker teams → PRs.

<span class="small">The same orchestrator→dispatcher→worker pattern that built the app also planned it.</span>

---

## What shipped in Volume 2

| Area | Shipped |
|---|---|
| **Data breadth** | Corpus **476 → 968**, four keyless sources (grants.gov, SAM, SBIR, USAspending) across six funding types |
| **Questionnaire** | Gate-first 13-field interview; *why-care* on every recommendation |
| **Matching** | E3 two-pass scoring · rubric-anchored prompt · **discernment layer** |
| **Intelligence** | Live **deep competitor & market analysis** (awarded grants + web) |
| **Application** | G1–G5 drafting engine · grants.gov S2S (mock) · **Chrome autofill extension** |
| **UX** | Progressive **streaming** · recommendation badges · welcome tour · branding |
| **Auth/infra** | Real Google OAuth · Vercel Pro · cost metering · consent gating |

---

## The headline: an honest *"don't apply"*

The concern, in the founder's words:

> *"If something isn't a good business idea… it'd be better if you didn't apply."*

A read-only review (15 live searches) found the matcher was **discerning on weak business models** but **over-generous in three structural ways**:

1. Ignored *stated* eligibility disqualifiers (foreign-owned, oversized).
2. Let unfocused pitches pile up cross-type "verify" cards.
3. Counted "high potential" as any score ≥ 33, and the raw score swung **±18** run-to-run.

---

## The discernment layer

A new, **pure** advisory verdict on every match (`lib/recommend.ts`):

| Verdict | When | Founder sees |
|---|---|---|
| `recommend` | score ≥ per-type floor **and** ≥60% criteria met | **Strong fit — worth pursuing** |
| `verify` | the honest middle | **Marginal — verify first** |
| `do_not_recommend` | score < 40, weak criteria, or a *stated* mismatch | **Not a fit — we don't recommend applying** |

- **"High potential" now counts `recommend` only.** The single biggest anti-inflation lever.
- A whole-map verdict: `thin_map` = *"even our best is a stretch."*
- **R8.4-safe:** advisory only; a "don't apply" from eligibility fires **only on a fact the founder stated**, never a model guess.

---

## Anchoring the score (killing the variance)

The root cause of the ±18 swing: the 0–100 scale had **no anchors**. The fix was a new prompt version, flag-gated:

```
SCORING SCALE — decide the BAND first, then the exact number:
  0-20   No fit / wrong funding mechanism.
  21-34  Adjacent — topically near, but not an applicant fit.
  35-54  Partial / verify — a real but incomplete fit.
  55-74  Strong — a genuine applicant fit on mechanism + technology.
  75-100 Exceptional — textbook fit; reserve for unambiguous cases.
```

<span class="small">Selected by <code>scorerPrompt()</code> only when the flag is on. Flag-off scoring is byte-identical. New version, shipped prompts + baseline hashes untouched.</span>

---

## We validated it with real money

A **golden-set re-validation**: all 31 entries driven live through the flag-on path (anchored scoring + discernment), cache blanked so nothing was faked.

| Case | Before | After |
|---|---|---|
| Unfocused "general-purpose AI" | 5–10 "high potential" | **thin_map, 0 recommend** |
| 800-employee firm (over SBIR cap) | 7 strong incl. "likely" | **thin_map, 0 recommend** |
| 70%-foreign-owned drone co | verify @38, no honest-no | **no_fit** — honest "don't apply" |
| Genuine strong cases | 35–72 swings | recommend at **62–72**, tighter |

**No fabrication, no leaks.** Then we enabled the flag in prod and verified a live weak input → `no_fit`, all-`do_not_recommend`.

---

## Streaming: 51 seconds stopped feeling like 51 seconds

The deep-analysis run takes ~50s. It used to show a frozen spinner the whole time.

Now the route streams **NDJSON**: progress + the *grounded evidence* (real awards, real competitor names) appear at **~5 seconds**, and the synthesized brief lands when it's validated.

- The model's brief still only renders **after** grounding + schema validation.
- The early evidence event carries **retrieval data only**, never a synthesized claim.
- Total compute unchanged; *perceived* wait transformed.

<span class="small">Same NDJSON idiom as the match route. One streaming pattern, reused.</span>

---

## The processes that made it safe

- **Worktree isolation.** Every subagent gets its own git worktree. Parallel agents never collide.
- **PR-per-task, central merge.** Workers open PRs; the orchestrator reviews and merges. Workers never merge.
- **Default-off flags.** Every risky feature (`e3_two_pass`, `discernment_layer`, `r5_deep_analysis` …) ships dark. Flag-off is always byte-identical to today.
- **Six gates, green before merge:** typecheck · test · build · check:hex · check:contrast · check:prompts.
- **Grounding as code.** Validators *throw* on ungrounded claims; the honest-no is a first-class output.

---

## The prompts (a pattern, not just text)

- **Scoring** (`explainMatches` / anchored v3): "*Be willing to say no.* Consumer marketplaces, local services, and no-R&D companies frequently have no strong federal match — say so plainly."
- **Discernment** is *not* a prompt. It's deterministic logic over the model's own met-criteria flags. The model scores; the code decides recommend/verify/don't-apply.
- **Competitor synthesis**: "Reference ONLY the supplied award records, by exact id. Never invent a company, amount, or URL."
- **Dispatcher prompts**: *Goal · Inputs · Output format · Constraints*. Every subagent gets a scoped, testable contract.

<span class="small">Full prompts live in <code>prompts/</code> and <code>scaffold/lib/prompts/registry.ts</code> (content-hash-locked).</span>

---

## Gotchas we paid for once

- **Anthropic credit exhaustion.** A full 31-search golden-set run drains ~$8–10 and 400s mid-run. Pace it; expect a top-up.
- **The masked-key that wasn't.** A `${VAR:-MISSING}` shell bug echoed two API keys into a transcript. Rotate on exposure; use `${VAR:+present}` only.
- **Stacked-PR de-stacking.** Squash-merging a base branch auto-closes the PR stacked on it. Cherry-pick the tip onto fresh main; resolve flag-registry conflicts keep-both.
- **`~/.zshrc` is interactive-only.** Non-interactive tool shells don't see the app's API keys. Source them explicitly.
- **Never dead-end a completed search.** Schema drift is logged (observability), never turned into an error. (The H1 lesson, re-learned.)

---

## By the numbers

<div>
<span class="tag">968 opportunities</span>
<span class="tag">4 sources · 6 funding types</span>
<span class="tag">823 tests · 0 failing</span>
<span class="tag">30/31 golden-set validated</span>
<span class="tag">~5s to first evidence</span>
<span class="tag">every feature flag-gated</span>
<span class="tag">0 fabricated claims</span>
</div>

<br>

**Architecture diagram:** the full seven-stage pipeline + adjacent engines + the build process. See `retrospective/granted-architecture.html`.

---

<!-- _class: lead -->

## The through-line

**Honest > comprehensive.**

A calibrated *"we don't recommend applying"* is not a failure of the product.
It's the most valuable thing it can say.

<span class="small">Volume 2 · orchestrated end-to-end with Claude Code.</span>
