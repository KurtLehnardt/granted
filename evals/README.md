# fundFinder Golden Set (EVL-01)

The rated eval corpus for fundFinder v2. Nothing downstream — interview lift (R1), latency-vs-quality
(R4b), false-exclusion rate (R8) — can be *measured* without it. Owned by **Team Evals**.

- `golden-set.jsonl` — 31 synthetic company descriptions, one JSON object per line.
- `rubric.md` — the TACA (Transparency / Accuracy / Calibration / Alignment) rating rubric.
- `README.md` — this file: schema, freeze/versioning, and how the set gates R1 / R4b / R8.

**Status: v1.0 FROZEN — product owner sign-off (citation-check), 2026-08-15.** The §5.4 named
reviewer is the product owner, who verified the eligibility rulings against their cited sources
(via a 5-reviewer, web-verified pass) and signed off. Frozen at the hash below
(`sha256:f79c6e57…cb04e4`). Two entries (`education-25`, `defense-hw-31`) carry rule statements
not yet independently re-verified — noted in the changelog; neither gates an exclusion. To change
a frozen set, cut a new version (@v1.1) — never edit in place.

---

## 1. What's in the set

31 entries (spec calls for 25–40). Companies are **fictional and clearly synthetic** (invented
names); the **eligibility answers are grounded in real, citable federal rules** — SBA size
standards and the SBIR/STTR small-business + US-ownership + ≤500-employee requirements
(SBA SBIR/STTR Policy Directive; 13 CFR 121.702), entity-type restrictions, STTR partnering and
work-split minimums, the Phase I → Phase II prerequisite, and SAM.gov/UEI registration prerequisites
(2 CFR 25). Where an answer would depend on program fine print we cannot cite confidently (Direct-to-
Phase-II authority, FOCI mitigation, tribal-ownership SBA affiliation rules, rural/underserved
designations, deployment-financing eligibility), the entry marks that bucket **`unknown` / judgment**
rather than asserting it — per §11 (escalate rather than invent) and R8.2 (say so where a gate can't
be determined).

### Coverage (distribution)

| Axis | Values (count) |
|---|---|
| **Sector** | defense_hardware 6 · climate 6 · biotech 5 · health_it 4 · dual_use_software 4 · education 3 · ambiguous 2 · consumer_software 1 |
| **Stage** | seed 11 · series_a 10 · pre_revenue 9 · pre_seed 1 |
| **Entity type** | for_profit_small_business 22 · unknown 3 · nonprofit 1 · institution_of_higher_education 1 · foreign_owned_entity 1 · individual 1 · state_or_local_government 1 · tribal_entity 1 |
| **Quality** | detailed 21 · medium 6 · one_line_vague 3 · brief 1 |

### Eligibility cases (≥25% required)

14 of 31 entries (45%) carry an `excluded` or `conditionally_eligible` bucket. **10 are dedicated
categorical-eligibility cases**, each exercising a distinct, citable rule:

| Entry | Rule exercised | Expected bucket |
|---|---|---|
| `biotech-07-nonprofit-research-institute` | SBIR/STTR require a **for-profit** small business concern | excluded from SBIR (as applicant) |
| `defense-hw-08-foreign-owned-drone` | SBIR/STTR **>50% US ownership** | excluded (70% foreign parent) |
| `health-it-09-no-sam-registration` | **SAM.gov + UEI** registration prerequisite (2 CFR 25) | conditionally eligible (register first) |
| `climate-10-phase2-no-phase1` | **Phase II requires prior Phase I** | excluded from standard Phase II |
| `education-11-university-ed-research` | SBIR/STTR require a small business concern (**IHE is not one**) | excluded from SBIR; eligible for research grants |
| `dualuse-sw-12-oversized-firm` | SBA **≤500-employee** size cap | excluded (~800 employees) |
| `biotech-13-solo-founder-no-entity` | Awardee must be a **business concern** (individual is not) | conditionally eligible (incorporate first) |
| `biotech-14-sttr-no-research-partner` | **STTR partnering** + 40/30 work-split requirement | conditionally eligible for STTR |
| `climate-20-municipal-utility` | Government entity is not a for-profit small business | excluded from SBIR; eligible for gov-restricted grants |
| `defense-hw-31-closed-solicitation-freshness` | **R8.3 freshness** — closed never shown as open | excluded from actionable set (status, not entity) |

Plus `defense-hw-30-us-incorporated-foreign-founder` as a **calibration** case (permanent residents
*do* count toward US ownership — a common misconception to get right), and conditional SAM buckets on
the well-formed cases (`health-it-01`, `defense-hw-02`, `biotech-06`, `education-25`).

### Deliberately hard cases (all present)

- **Matches nothing:** `education-05-youth-activity-marketplace`, `consumer-17-dating-app`.
- **Matches a dozen equally:** `dualuse-sw-16-generic-ai-platform`.
- **Ambiguous sector:** `climate-defense-15-ambiguous-microgrid`,
  `biotech-28-ai-drug-discovery-ambiguous`.
- **One-line vague (R1 drivers):** `health-it-18`, `climate-19`, `defense-hw-32`.

The five v1 demo cases from `scaffold/lib/testCases.ts` are included, re-rated, as entries `01`–`05`.

---

## 2. Entry schema

One JSON object per line. Every entry has exactly these keys:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable unique id (`{sector}-{NN}-{slug}`). Never reuse or renumber. |
| `description` | string | The synthetic company description fed to the pipeline. |
| `sector` | string | One of the coverage sectors, or `ambiguous` / `consumer_software`. |
| `stage` | string | `pre_revenue` \| `pre_seed` \| `seed` \| `series_a`. |
| `entity_type` | string | `for_profit_small_business` \| `nonprofit` \| `institution_of_higher_education` \| `foreign_owned_entity` \| `individual` \| `state_or_local_government` \| `tribal_entity` \| `unknown`. |
| `quality` | string | `one_line_vague` \| `brief` \| `medium` \| `detailed`. |
| `should_appear` | string[] | Program families / agencies a good map **should** surface. Family-level, not solicitation numbers (those move). |
| `should_not_appear` | string[] | Families that must **not** be in the eligible / actionable set. May still appear in the collapsed excluded list with a reason (R8.2). |
| `eligibility_bucket_expectations` | object | Map of `program/family → { bucket, rule, reason }`. `bucket` ∈ `eligible` \| `conditionally_eligible` \| `excluded` \| `unknown`, mirroring R8.2 (+ `unknown`). `rule` cites the governing federal rule; `reason` ties it to this company. |
| `taca_notes` | string | What a good map looks like for this entry, across all four TACA axes. The rater reads this before scoring. |

Buckets map directly onto the `EligibilityDetermination` contract (§3.5) and R8's three-bucket
output; `unknown` corresponds to R8.2's "eligibility depends on X — tell us and we'll screen this."

---

## 3. Freeze and versioning

**Why:** "An eval set that drifts while you optimize against it measures nothing" (§5.4). Once frozen,
the content of `golden-set.jsonl` does not change under an optimization campaign; changes mint a new
version.

### Version identity = content hash of the JSONL

The set is identified by the SHA-256 of `golden-set.jsonl` (byte-exact, including newlines):

```bash
shasum -a 256 evals/golden-set.jsonl        # macOS
sha256sum   evals/golden-set.jsonl          # Linux
```

**Frozen hash (v1.0, product-owner sign-off 2026-08-15):**

```
sha256:f79c6e579f39431cc2b48cc8073569e529473be796cf0af46041a5e7a4cb04e4
```

Recompute after any edit; if the hash changed, the version changed.

### Freeze procedure (run once the §5.4 reviewer signs off)

1. Named reviewer completes the first reference rating for every entry using `rubric.md`.
2. Apply any corrections the review surfaces to `golden-set.jsonl`.
3. Recompute the hash. Record it as the frozen version:
   `golden-set@v1.0 = sha256:<hash>`.
4. Tag the commit (e.g. `git tag evals/golden-set@v1.0`) and record `{version, hash, reviewer,
   date}` in this README's changelog (below). The commit tag is the immutable reference (§5.4
   "freeze and version it").
5. Every run executed under test records **which golden-set version (hash/tag)** it ran against,
   alongside prompt version and Canon snapshot (R10.2) — so a result is reproducible.

### Changing a frozen set

Never edit in place. Add entries or fix errors on a **new version** (`@v1.1`, new hash/tag). Baselines
(latency p50/p95, false-exclusion rate, TACA scores) are only comparable **within one version** — a
regression gate (EVL-02) that compares across versions is comparing nothing.

### Adding real (non-synthetic) submissions

Real user descriptions may be added **only** where the §5.3 consent record shows an affirmative,
timestamped grant, and the entry must record which run it came from so consent can be traced and
honored on revocation (§5.4). Consent-off descriptions are a hard constraint — never ingested. No such
entries exist yet (no consented traffic — §5.3); the current set is 100% synthetic.

### Changelog

| Version | Hash | Reviewer | Date | Notes |
|---|---|---|---|---|
| v0.1 (draft, unfrozen) | `218c344e…585b8d` | — (unassigned, §5.4 `[DECIDE]`) | 2026-08-15 | Initial 31-entry synthetic draft. Awaiting named-reviewer reference rating. |
| **v1.0 (FROZEN)** | `f79c6e57…cb04e4` | **Product owner (citation-check)** | 2026-08-15 | Corrections applied per 5-reviewer web-verified pass (8 edits, each primary-source-backed); owner signed off. `education-25` and `defense-hw-31` rule citations remain PENDING owner verification (neither gates an exclusion). **Frozen reference for R1/R4b/R8 acceptance.** |

> **Pending owner verification (2 entries).** `education-25-k12-edtech-forprofit` (the claim that ED
> operates an SBIR program via IES) and `defense-hw-31-closed-solicitation-freshness` (the R8.3
> freshness handling) carry rule statements the 5-reviewer pass did **not** independently confirm
> against a primary federal source. They are retained as-is and flagged for the named owner to verify
> before the v1.0 freeze — no citation was invented for either (§11: escalate rather than invent).

---

## 4. How this set gates R1, R4b, and R8

Team Evals owns the regression gate; the set is the measurement surface for three acceptance
criteria (§9). The **harness/runner (CON-05)** and the **CI regression gate (EVL-02)** are out of
scope for EVL-01 — this deliverable is the corpus + rubric they consume.

- **R1 (pre-search interview).** Run each entry **with** and **without** the interview and blind-rate
  both outputs on the rubric (§9 R1: "blind eval shows measurably better program matching with
  interview vs. without"). The `one_line_vague` and `ambiguous` entries are the primary lift
  detectors; the eligibility entries test R1's requirement to **ask the gating question first**
  (does knowing entity type flip a map from a confident guess to the correct excluded/unknown
  bucket?).

- **R4b (latency vs. quality).** Every merged optimization runs the full set and reports **latency
  delta and quality delta together** (§9 R4b, §5.4 step 3). A speedup that drops any entry's TACA
  score or flips a correct eligibility bucket is a **quality regression** and must be rejected. Freeze
  matters most here: the p95/quality baseline is only meaningful against a fixed hash.

- **R8 (eligibility + freshness).** The 10 dedicated eligibility cases plus the freshness case are
  the **false-exclusion / false-inclusion** test bed. The primary R8 error metric is a **false
  exclusion** — an entry the system marks `excluded` whose expected bucket is `eligible`,
  `conditionally_eligible`, or `unknown` — because "a founder told they are ineligible on the
  strength of a hallucinated rule is the worst single failure this product can produce" (R8.4). The
  `unknown`-bucket entries specifically test that the system says "depends on X" instead of guessing.

Related: R2's classifier and R3's unsupported-claim check (Team Evals' other measures, §6) reuse this
same corpus but are scored with their own criteria, not this rubric.

---

## 5. Named-reviewer requirement (§5.4) — RESOLVED (product owner, citation-check, 2026-08-15)

§5.4 requires a **named human reviewer** to set the reference the first time: *"Model-graded evals
are fine for regression detection but a human sets the reference the first time."* No reviewer is
assigned. This is a **product-owner decision**, already tracked as an open question
("§5.4 named human eval rater — needs an owner before the golden set is trusted").

**Until a reviewer is named and completes the first rating, this set is a draft and cannot serve as
the reference baseline for R1 / R4b / R8 acceptance.** Regression-only model grading is explicitly
insufficient for the initial baseline (EVL-01 "Escalate if"). This is the one blocker on freezing
v1.0.
