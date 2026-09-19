# fundFinder Golden Set — Citation Review Sheet

**Status: v0.1 — UNFROZEN.** Source: `evals/golden-set.jsonl` (31 entries), `evals/rubric.md`, `evals/README.md`.

## What this is

31 synthetic companies, each with a claimed eligibility answer for one or more federal funding
programs. Your job as reviewer: confirm the **cited rule is real and correctly applied** to each
company — you do not need to be an SBIR expert going in, you need to be able to look up the cited
rule and see if it says what we say it says.

- Entries marked **unknown** are intentional — we deliberately did not assert an answer because the
  fine print is fact-specific or the input didn't give us enough to go on. Nothing to confirm there
  beyond agreeing the hedge itself is reasonable.
- This set stays a draft until every entry is reviewed and any corrections are folded back into
  `golden-set.jsonl`; only then does it get hashed and tagged `v1.0` per the README's freeze
  procedure (tracked as an open question, §5.4 — named reviewer still unassigned).

**Legend:** `eligible` / `conditional` / `excluded` / `unknown` (intentionally unasserted). A ⚑
next to a citation means **no citation was given in the entry itself** — check those first.

**Methodology note:** the "rule to verify" per entry is quoted from the entry's own
`eligibility_bucket_expectations.rule` field. Where that text contains no legal citation (a CFR
section, the SBA SBIR/STTR Policy Directive, 2 CFR 25, etc.), the entry is flagged rather than
silently given a citation it doesn't have. The recurring boilerplate SBIR core rule (for-profit,
&lt;500 employees, &gt;50% US-owned) is grounded once, in the README, at **13 CFR 121.702 / SBA
SBIR/STTR Policy Directive** — entries that restate it in plain English without repeating the cite
inline are *not* flagged for that reason alone.

---

## Section A — Check these first: dedicated eligibility & calibration cases (11)

These exist specifically to exercise one citable eligibility rule each (10 categorical cases, plus
one calibration case testing a common misconception). This is the ~15-minute core of the review.

### 1. `biotech-07-nonprofit-research-institute` — ELIGIBILITY
- biotech · pre-revenue · nonprofit
- 501(c)(3) nonprofit research institute studying antimicrobial resistance, wants SBIR for a diagnostic.
- Buckets: SBIR/STTR (as applicant) → **excluded** · NIH R-series/NSF grants → **eligible** · STTR research-partner role → **eligible**
- **Rule to verify:** A nonprofit cannot be the SBIR/STTR awardee — only a for-profit small business concern qualifies. It can still participate as the STTR research-institution partner.
  **Citation:** SBA SBIR/STTR Policy Directive; 13 CFR 121.702
- Should appear: NIH R-series, NSF, STTR research-partner role · Should not: SBIR/STTR as the applicant
- Confirmed? [ ]

### 2. `defense-hw-08-foreign-owned-drone` — ELIGIBILITY
- defense hardware · seed · foreign-owned
- US-registered surveillance-drone maker, 70% owned by a foreign parent, seeking federal R&D funding.
- Buckets: SBIR/STTR → **excluded** · DoD/IC procurement (FOCI) → **conditionally_eligible**
- **Rule to verify:** 70% foreign-parent ownership fails the >50% US-ownership gate. US incorporation is NOT the gate — ownership is.
  **Citation:** SBA SBIR/STTR Policy Directive; 13 CFR 121.702
- ⚑ **Also check:** the "DoD/IC procurement" bucket is labeled `conditionally_eligible` for FOCI mitigation, but the entry's own reasoning text says to "treat as judgment" and gives **no citation**. Worth asking whether that bucket should be `unknown` instead — it reads hedged but is coded as an assertion.
- Should appear: commercial/VC paths, subcontractor teaming · Should not: SBIR/STTR, cleared DoD/IC procurement
- Confirmed? [ ]

### 3. `health-it-09-no-sam-registration` — ELIGIBILITY
- health IT · pre-seed · for-profit
- 4-person new medication-adherence startup, no SAM.gov/UEI yet, chasing a Grants.gov deadline.
- Buckets: Grants.gov NOFO (target) → **conditionally_eligible** · NIH/AHRQ SBIR → **conditionally_eligible**
- **Rule to verify:** Active SAM.gov registration plus a UEI is required before any federal award. Registration commonly takes weeks and can outrun a near-term deadline.
  **Citation:** 2 CFR 25
- Should appear: NIH/AHRQ SBIR, Grants.gov (after registering) · Should not: anything shown as submit-ready before registration
- Confirmed? [ ]

### 4. `climate-10-phase2-no-phase1` — ELIGIBILITY
- climate · seed · for-profit
- Grid-forming inverter firm with no prior Phase I wants to apply straight to a DOE Phase II topic.
- Buckets: SBIR/STTR Phase II (standard) → **excluded** · Direct-to-Phase-II (agency-specific) → **unknown** · SBIR/STTR Phase I → **eligible**
- **Rule to verify:** Standard Phase II requires a prior Phase I award on the same project line. No Phase I means the standard Phase II path is closed — Phase I is the correct entry point.
  **Citation:** SBA SBIR/STTR Policy Directive
- Should appear: DOE/NSF SBIR Phase I · Should not: standard Phase II presented as directly applicable
- Confirmed? [ ]

### 5. `education-11-university-ed-research` — ELIGIBILITY
- education · pre-revenue · university/IHE
- Public-university lab studying adaptive math instruction wants funding for a multi-site efficacy trial.
- Buckets: IES/NSF education research grants → **eligible** · SBIR/STTR (as applicant) → **excluded**
- **Rule to verify:** A university is not a for-profit small business concern and cannot be the SBIR/STTR awardee — the research-grant mechanisms are the intended vehicle instead.
  **Citation:** 13 CFR 121.702
- Should appear: ED/IES, NSF research grants · Should not: SBIR/STTR
- Confirmed? [ ]

### 6. `dualuse-sw-12-oversized-firm` — ELIGIBILITY
- dual-use software · series A · for-profit
- Established cybersecurity firm, ~800 employees and $120M revenue, wants SBIR set-aside funding.
- Buckets: SBIR/STTR → **excluded** · Full-and-open R&D contracts → **eligible**
- **Rule to verify:** ~800 employees exceeds the 500-employee small-business size cap (affiliates are counted too) — SBIR/STTR set-asides are closed to this firm regardless of merit.
  **Citation:** 13 CFR 121.702 (SBA size standard for SBIR/STTR)
- Should appear: full-and-open R&D contracts, OTAs, BAAs · Should not: SBIR/STTR set-asides
- Confirmed? [ ]

### 7. `biotech-13-solo-founder-no-entity` — ELIGIBILITY ⚑ FLAGGED
- biotech · pre-revenue · individual, no company
- Solo scientist with an enzyme-engineering idea and a provisional patent, no company formed yet.
- Buckets: SBIR/STTR → **conditionally_eligible**
- **Rule to verify:** The SBIR/STTR awardee must be a for-profit small business concern — an individual isn't one until they incorporate. Eligible after forming a qualifying US entity, not before.
  **Citation: none given in this entry.**
  ⚑ No citation given. Compare `biotech-07` and `education-11`, which make the same kind of claim (the concern must be a for-profit business) and do cite 13 CFR 121.702 — that's very likely the right cite here too. Confirm and add it.
- Should appear: SBIR/STTR after incorporating; I-Corps-style programs first · Should not: SBIR/STTR presented as directly available to an individual
- Confirmed? [ ]

### 8. `biotech-14-sttr-no-research-partner` — ELIGIBILITY
- biotech · seed · for-profit
- 5-person cryo-preservation media startup with no research-institution partner, asking about STTR.
- Buckets: STTR → **conditionally_eligible** · SBIR → **eligible**
- **Rule to verify:** STTR requires a partnering research institution performing at least 30% of the work, with the small business performing at least 40%. No partner in place means STTR isn't satisfied yet — SBIR (no partner required) is the better-fit path today.
  **Citation:** SBA SBIR/STTR Policy Directive
- Should appear: SBIR now; STTR once a partner is secured · Should not: STTR presented as submit-ready with no partner
- Confirmed? [ ]

### 9. `climate-20-municipal-utility` — ELIGIBILITY ⚑ FLAGGED
- climate · pre-revenue · gov't entity
- City-owned municipal water utility wants federal funding to modernize its treatment plant.
- Buckets: EPA/DOE state-local grants → **eligible** · SBIR/STTR → **excluded**
- **Rule to verify:** A municipal government entity is not a for-profit small business concern and cannot be the SBIR/STTR awardee.
  **Citation: none given in this entry.**
  ⚑ No citation given — but this is the exact same category of claim as `biotech-07` and `education-11`, both of which cite 13 CFR 121.702 for it. Looks like an oversight rather than a genuinely different rule; confirm the same cite applies here and add it.
- Should appear: EPA/DOE/DOT state-and-local grant programs · Should not: SBIR/STTR
- Confirmed? [ ]

### 10. `defense-hw-30-us-incorporated-foreign-founder` — CALIBRATION
- defense hardware · seed · for-profit
- Delaware robotics C-corp; a green-card holder and a US citizen own 65% and worry it disqualifies SBIR.
- Buckets: SBIR/STTR → **eligible** · Topic-level security requirements → **unknown**
- **Rule to verify:** US-ownership is satisfied by >50% ownership/control held by US citizens OR permanent resident aliens — green-card holders count. Employees' visa status does not affect ownership eligibility.
  **Citation:** 13 CFR 121.702
- Note: this is the "common misconception" case — the citation checks out; what's worth confirming carefully is that the rule is *stated correctly* (permanent residents count), since this is exactly the kind of thing people get backwards.
- Should appear: DoD/NSF/DOE SBIR (robotics) · Should not: advice that the green-card founder's ownership disqualifies the firm
- Confirmed? [ ]

### 11. `defense-hw-31-closed-solicitation-freshness` — ELIGIBILITY · freshness ⚑ FLAGGED
- defense hardware · seed · for-profit
- Electric-propulsion-for-satellites firm asks if a prior-year SBIR topic they read about is still open.
- Buckets: named prior-year topic (if closed) → **excluded** · currently-open propulsion topics → **eligible**
- **Rule to verify:** A closed solicitation must never be presented as open or actionable, even though the firm itself is fully eligible. The exclusion here is about the topic's status, not the company.
  **Citation:** R8.3 (internal fundFinder freshness policy)
  ⚑ The cite here is fundFinder's own internal spec section (R8.3), not an external federal rule — because this is a product freshness policy, not a law. That's likely correct as-is; flagged so you don't go hunting for a federal citation that doesn't exist for this one.
- Should appear: currently-open propulsion SBIR topics · Should not: the closed prior-year topic shown as apply-now
- Confirmed? [ ]

---

## Section B — Also carries an eligibility gate (4)

Well-formed matching cases with one incidental exclusion/conditional bucket alongside the main
match. Worth a quick citation check, lower stakes than Section A.

### 12. `health-it-01-ai-nurse-admin` ⚑ FLAGGED
- health IT · series A · for-profit
- 15-person Utah AI nurse-admin software startup, $1M ARR, seeking $500K–$2M non-dilutive.
- Buckets: NIH SBIR/STTR → **eligible** · NIH R01/R21 → **excluded**
- **Rule to verify:** NIH R01/R21 research-grant activity codes are institution-oriented, not a for-profit startup vehicle — SBIR/STTR is the correct mechanism instead.
  **Citation: none given.** ⚑ No citation for this specific claim about R01/R21's intended applicant class (distinct from the standard SBIR ownership/size rule, which is well-established elsewhere in the set).
- Should appear: NIH/AHRQ/NSF SBIR-STTR · Should not: NIH R01/R21, state/local grants
- Confirmed? [ ]

### 13. `defense-hw-02-aero-manufacturing`
- defense hardware · series A · for-profit
- 35-person Utah aerospace structural-components manufacturer, $3M revenue, seeking $2–5M scale-up.
- Buckets: DoD SBIR/STTR → **eligible** · SAM.gov procurement → **conditionally_eligible**
- **Rule to verify:** Active SAM.gov registration plus a UEI is required before any award; unregistered is a weeks-long prerequisite, not a permanent bar.
  **Citation:** 2 CFR 25 / FAR
- Should appear: DoD/NASA/DOE SBIR, SAM.gov procurement · Should not: NIH, ED/IES grants
- Confirmed? [ ]

### 14. `biotech-06-precision-onco-therapeutic` ⚑ FLAGGED
- biotech · pre-revenue · for-profit
- 6-person pre-revenue Delaware biotech spinout developing a small-molecule solid-tumor therapeutic.
- Buckets: NIH SBIR → **eligible** · NIH STTR → **conditionally_eligible**
- **Rule to verify:** STTR requires a partnering research institution performing at least 30% of the work, with the business performing at least 40%.
  **Citation: none given.** ⚑ The identical rule is cited (SBA SBIR/STTR Policy Directive) over at `biotech-14`. Worth pulling that citation across for consistency.
- Should appear: NIH SBIR/STTR, BARDA-adjacent translational SBIR · Should not: NIH R01, DoD, ED/IES funding
- Confirmed? [ ]

### 15. `education-25-k12-edtech-forprofit` ⚑ FLAGGED
- education · series A · for-profit
- 14-person K-12 adaptive math SaaS, $2M ARR, wants funding to build and validate an efficacy study.
- Buckets: ED/IES SBIR → **eligible** · IES research grants (institution-restricted) → **excluded**
- **Rule to verify:** Some IES research-grant mechanisms are restricted to IHEs/LEAs/nonprofits as the applicant — a for-profit isn't one, though it can participate as a partner.
  **Citation: none given.** ⚑ No citation for which specific IES mechanisms are institution-restricted.
- Should appear: ED/IES SBIR, NSF SBIR · Should not: NIH/DoD funding, IES institution-only research grants
- Confirmed? [ ]

---

## Section C — Matching-only cases: glance (16)

Pure program-matching tests (or intentional empty-result / interview-first tests) built on the
standard SBIR/STTR core rule — for-profit US small business, under 500 employees, majority
US-owned (13 CFR 121.702; SBA SBIR/STTR Policy Directive). Not repeated per row below; skim the
bucket outcomes for anything that looks off.

| # | ID | Snapshot | Gist | Eligibility | Should / shouldn't appear | Confirmed? |
|---|---|---|---|---|---|---|
| 16 | `climate-03-water-loss-sensors` | climate · seed · for-profit | 10-person Utah water-loss sensor/AI startup for municipalities, seeking $500K–$3M. | EPA SBIR/STTR → eligible · State revolving funds → unknown (out of Canon scope) | + EPA/DOE/NSF SBIR / − NIH, DoD weapons, state loans shown as federal | [ ] |
| 17 | `dualuse-sw-04-cyber-threat-detection` | dual-use software · series A · for-profit | 22-person Utah AI cybersecurity threat-detection startup, $2M ARR, seeking $1–3M. | DoD/DHS SBIR → eligible | + DoD/DHS/NSF SBIR, SAM.gov / − NIH, USDA rural, state grants | [ ] |
| 18 | `education-05-youth-activity-marketplace` | education · seed · for-profit | 8-person Utah marketplace connecting parents with youth activities, seeking $250K–$1M. | SBIR/STTR → unknown (technically eligible, likely nothing to match) | + none expected (flagship "honest empty result" test) / − SBIR/STTR, ED/IES, NIH/NSF/DoD | [ ] |
| 19 | `climate-defense-15-ambiguous-microgrid` | ambiguous · seed · for-profit | 12-person ruggedized portable-microgrid maker powering both forward bases and disaster response. | DOE + DoD SBIR/STTR → eligible (both branches) | + DOE SBIR, DoD SBIR, DHS/FEMA topics / − NIH, ED/IES grants | [ ] |
| 20 | `dualuse-sw-16-generic-ai-platform` | dual-use software · series A · for-profit | 18-person general-purpose AI/ML platform selling across healthcare, finance, logistics, government. | SBIR/STTR (many agencies) → eligible — breadth is the issue, not eligibility | + NSF/DoD/DHS/DOE/NIH SBIR (broad) / − one confidently-ranked "best fit" program | [ ] |
| 21 | `consumer-17-dating-app` | consumer software · seed · for-profit | 6-person consumer dating app for outdoor-enthusiast singles, seeking growth capital. | SBIR/STTR → unknown (technically eligible, no mission nexus) | + none expected / − SBIR/STTR, all federal research families | [ ] |
| 22 | `health-it-18-one-line-vague` | health IT · pre-revenue · unknown | One line: "We do AI for hospitals." Entity type unknown. | SBIR/STTR → unknown (nothing stated yet) | + pending interview only / − any confident ranked map before questions asked | [ ] |
| 23 | `climate-19-one-line-vague` | climate · pre-revenue · unknown | Two words: "clean energy startup." Entity type unknown. | SBIR/STTR → unknown (two words, nothing to determine) | + pending interview only / − any confident ranked map | [ ] |
| 24 | `biotech-21-tribal-enterprise` | biotech · seed · tribal enterprise | Tribally-owned for-profit, under 40 employees, plant-derived agricultural pest-control compounds. | USDA/NSF SBIR → eligible · tribal ownership/affiliation specifics → unknown | + USDA NIFA, NSF, DOE SBIR / − opportunities restricted to individuals/non-business entities | [ ] |
| 25 | `defense-hw-23-hypersonics-materials` | defense hardware · series A · for-profit | 45-person hypersonic ceramic-matrix-composite maker, $4M revenue, wants R&D plus a procurement path. | DoD SBIR/STTR → eligible | + DoD/NASA/DOE SBIR, SAM.gov/BAAs / − NIH, ED funding | [ ] |
| 26 | `climate-24-grid-battery` | climate · series A · for-profit | 28-person iron-based grid-scale battery maker, $1.5M revenue, wants pilot-deployment funding. | DOE SBIR/STTR → eligible · DOE deployment/loan programs → unknown | + DOE SBIR, ARPA-E-style, NSF / − NIH/DoD-only, state incentives shown as federal | [ ] |
| 27 | `dualuse-sw-26-ml-infrastructure` | dual-use software · series A · for-profit | 20-person distributed-ML-training infrastructure startup, $1M ARR, wants defense/IC interest. | DoD/NSF/DOE SBIR → eligible | + DoD/NSF/DOE SBIR, IC topics / − NIH/USDA/ED funding | [ ] |
| 28 | `health-it-27-telehealth-medium` | health IT · seed · for-profit | 12-person rural telehealth platform wants funding to expand into more underserved areas. | SBIR/STTR → eligible · rural-designated programs → unknown (must confirm designation) | + HRSA, NIH/AHRQ SBIR, USDA rural / − DoD weapons, assumed rural status | [ ] |
| 29 | `biotech-28-ai-drug-discovery-ambiguous` | ambiguous · series A · for-profit | 16-person AI protein-ligand-binding software firm also running an internal drug-discovery pipeline. | NIH + NSF/DOE SBIR → eligible (both branches) | + NIH SBIR, NSF/DOE SBIR (both) / − a single-sector map dropping either side | [ ] |
| 30 | `climate-29-agtech-precision` | climate · pre-revenue · for-profit | 9-person pre-revenue agtech soil-sensor startup cutting fertilizer runoff on row crops. | USDA NIFA SBIR → eligible · NRCS conservation programs → unknown | + USDA NIFA, NSF, EPA SBIR / − NIH/DoD/ED, state cost-share shown as federal | [ ] |
| 31 | `defense-hw-32-one-line-vague` | defense hardware · pre-revenue · unknown | Three words: "we build drones." Entity type and application unknown. | SBIR/STTR → unknown (ownership specifically unconfirmed) | + pending interview only / − any confident map before entity/ownership/application known | [ ] |

---

## Flagged citations — summary (7)

Entries asserting an eligibility answer (`eligible` / `excluded` / `conditionally_eligible`) whose
`rule` text contains no legal citation, beyond the standard README-backed SBIR core rule:

1. `health-it-01-ai-nurse-admin` — NIH R01/R21 exclusion reasoning
2. `defense-hw-08-foreign-owned-drone` — DoD/IC procurement FOCI-mitigation bucket
3. `biotech-06-precision-onco-therapeutic` — NIH STTR work-split claim (cited elsewhere at `biotech-14`)
4. `biotech-13-solo-founder-no-entity` — "individual is not a business concern" claim
5. `climate-20-municipal-utility` — "government entity is not a for-profit business" claim
6. `education-25-k12-edtech-forprofit` — IES institution-restricted-mechanisms claim
7. `defense-hw-31-closed-solicitation-freshness` — citation is internal spec (R8.3), not federal law

Source: `evals/golden-set.jsonl` · `evals/rubric.md` · `evals/README.md`. Named-reviewer sign-off tracked as an open question (§5.4).
