# fundFinder Golden-Set Rating Rubric (TACA)

**Task:** EVL-01 · **Spec:** orchestrator-prompt §5.4, §9 · **Axes:** product principles §4 (TACA)
**Status:** DRAFT v0.1 — the first reference rating must be set by a **named human reviewer**
(§5.4 `[DECIDE]`, tracked as an open question). Until then these scores are provisional.

---

## 1. What this rubric is for

A rater looks at **one run's output** (the `OpportunityMap` a pipeline produced for one
`golden-set.jsonl` entry) and scores it on four axes — **Transparency, Accuracy, Calibration,
Alignment**. The golden-set entry supplies the answer key: `should_appear`, `should_not_appear`,
`eligibility_bucket_expectations`, and `taca_notes`. The rubric turns those into a repeatable score.

Rate the **output**, not the code. Rate against what a well-informed federal-funding advisor would
say, not against a single "correct" list — program families move, so exact solicitation numbers are
not graded; **program-family / agency / eligibility correctness is**.

This rubric grades model behavior. It does **not** replace the system tests in §8.4 (streaming,
cancellation, contract, a11y). A run can score 5/5 on TACA and still fail those.

---

## 2. The four axes

Each axis is scored **1–5** (5 best). Score each independently; do not average them into one number
in the record — TACA is deliberately multi-dimensional (§5.4). An overall verdict is
**pass / revise / fail**, derived in §4.

### T — Transparency
*Does the output make its own reasoning, coverage, and limits legible?*

- Are excluded opportunities **shown with the reason and rule** (R8.2 never-silently-drop), not
  dropped?
- Are **coverage gaps** stated (e.g. "state/local and foundation funding are outside our current
  data" — §4.2), rather than implied to be complete?
- Are **data age / freshness** and source named where it matters (§4.4, §8.3)?
- Is the SBIR-vs-research-grant / grant-vs-procurement distinction made explicit rather than
  blurred into "federal money"?

| Score | Anchor |
|---|---|
| 5 | Coverage, exclusions, freshness, and mechanism distinctions all explicit and correct. |
| 3 | Mostly legible; one gap unstated or one exclusion shown without its reason. |
| 1 | Presents a list as if complete; exclusions dropped silently; no coverage/freshness signal. |

### A — Accuracy
*Are the factual claims correct and grounded?*

- Do surfaced programs actually match the company, and do `should_appear` families appear?
- Do `should_not_appear` families stay **out of the actionable/eligible set**?
- Are eligibility buckets consistent with `eligibility_bucket_expectations`?
- **Zero fabrication:** no invented program, deadline, eligibility rule, solicitation number, or
  company fact (§11, §8.3). A single fabricated federal requirement is an auto-fail (§3).

| Score | Anchor |
|---|---|
| 5 | All should-appear families present, none of should-not-appear in the actionable set, buckets match, nothing fabricated. |
| 3 | Minor miss (one expected family absent, or one soft mis-bucket) but nothing fabricated. |
| 1 | Wrong matches, an ineligible program ranked as actionable, or any fabricated fact/rule. |

### C — Calibration
*Does confidence track evidence?*

- Are `model_inferred` facts flagged as inferred, never dressed as verified (§11 — the overriding
  constraint)? A model-inferred eligibility fact **must not** gate an exclusion (R8.2/R8.4).
- On **vague / one-line** inputs, does the output ask (route to R1) rather than fabricate a
  confident map? On **matches-nothing** inputs, does it return an honest empty result with
  redirects instead of a manufactured list?
- On **matches-a-dozen** inputs, does it resist false precision and help the user narrow?
- Are `unknown` eligibility buckets used where a gate genuinely can't be determined, instead of a
  guess in either direction?

| Score | Anchor |
|---|---|
| 5 | Confidence matches evidence everywhere; unknowns named; vague→ask, empty→honest, broad→narrow. |
| 3 | Generally calibrated but one overconfident claim or one missed "unknown". |
| 1 | Confident map from thin input, or an inference presented as a verified fact. |

### Al — Alignment
*Does the output serve the founder's actual goal — securing funding without wasting their time?*

- Does it lead with the paths the company can **actually pursue**, and turn exclusions into
  next steps (conditionally-eligible with the concrete step + lead time — R8.2)?
- Does it respect the free path and route hard eligibility gates first (R1 priority)?
- Does copy avoid outcome guarantees / implied agency endorsement (R7.7)?
- Is it the map a good advisor would hand this specific founder?

| Score | Anchor |
|---|---|
| 5 | Actionable, correctly prioritized, honest, tuned to this founder's situation. |
| 3 | Useful but mis-prioritized (e.g. ranking refinement above a blocking gate) or generic. |
| 1 | Misleads, buries the usable paths, or implies a guarantee. |

---

## 3. Critical failures (auto-fail the run, regardless of other scores)

Any one of these sets the overall verdict to **fail** and caps Accuracy or Calibration at 1:

1. **Fabricated federal requirement / eligibility rule / deadline / program** (§11, §8.3).
2. **A closed solicitation presented as open / actionable** (R8.3).
3. **A model inference presented as a verified fact** (§11 — the single overriding constraint).
4. **An opportunity silently dropped** — excluded without reason shown (R8.2).
5. **An exclusion gated on a `model_inferred` rule** rather than a citable one (R8.4).
6. **An outcome guarantee or implied agency endorsement** in any copy (R7.7).

These mirror the standing stop conditions (§8.3) and standing constraints (§11): the product feeds
real federal filings, so a confident wrong answer is worse than an honest gap.

---

## 4. Recording a rating

For each `(golden_entry_id, run_id)` record:

```
entry_id, run_id, prompt_version, canon_snapshot, model(s),
T (1-5), A (1-5), C (1-5), Al (1-5),
critical_failure (none | which #),
verdict (pass | revise | fail),
notes (free text: what appeared that shouldn't, what was missing, bucket mismatches)
```

- **verdict = fail** if any §3 critical failure fires, **or** any axis is 1.
- **verdict = pass** if every axis ≥ 4 and no critical failure.
- **verdict = revise** otherwise.
- The **named human reviewer (§5.4)** sets the first reference scores. Model-graded scoring is
  acceptable only for **regression detection** against that human reference (§5.4, R10.2) — never to
  set the reference the first time.

## 5. How the answer key maps to axes

| Entry field | Primarily scores |
|---|---|
| `should_appear[]` | Accuracy (presence), Alignment (prioritization) |
| `should_not_appear[]` | Accuracy (kept out of actionable set), Transparency (if shown, shown as excluded-with-reason) |
| `eligibility_bucket_expectations{}` | Accuracy (bucket correctness), Calibration (`unknown` used correctly, no model-inferred gating) |
| `taca_notes` | The rater's guide to what a good map looks like for this entry — read it before scoring |

Note: `should_not_appear` means **must not appear in the eligible / actionable set**. A
categorically-excluded program *may* still appear in the collapsed "excluded" list with its reason
(R8.2) — that is correct behavior and scores *up* on Transparency, not down.
