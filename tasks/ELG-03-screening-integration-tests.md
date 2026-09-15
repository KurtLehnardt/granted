# ELG-03 — screening engine integration tests against real Canon rules

**Team:** Eligibility
**Release slice:** 2
**Depends on:** ELG-01 (`lib/eligibility/screen.ts`), CAN-01 (`lib/canon/store.ts`), CAN-04
(`lib/canon/rules.ts` — per-opp `model_inferred` rules), the universal overlay (`lib/canon/universalRules.ts`)

## Context
ELG-01's unit tests exercise the screening engine on hand-built fixtures. This task validates the same
engine against the **REAL Canon data**: the ~946 per-opportunity `model_inferred` rules in Supabase plus
the universal overlay, for a sample of real opportunities pulled **READ-ONLY**. The two non-negotiable
invariants to prove on real data (R8 / R8.4 / §11):

1. **ZERO false exclusions** — no real opportunity in the sample lands in `excluded` (real Canon rules
   are all `model_inferred`; per R8.4 they must never drive an exclusion, so nothing should).
2. **R8.4 holds across the real rule set** — every `model_inferred` per-opp rule, when screened, ends up
   in `satisfied` / `unknown` / advisory (skipped) — **never** in `failed_rules`.

## Files in scope
- CREATE `scaffold/lib/eligibility/__tests__/screen.integration.test.ts` — the integration test,
  **guarded to SKIP gracefully** (not fail) when `FUNDFINDER_DB_PASSWORD` is unset or the DB is
  unreachable, so `npm test` stays green in every environment.
- CREATE a short findings note (e.g. `scaffold/lib/eligibility/__tests__/ELG-03-findings.md`) recording
  sample size, bucket distribution, and confirmation of zero false exclusions.
- OPTIONAL: strengthen edge-case coverage in `scaffold/lib/eligibility/__tests__/screen.test.ts`
  (fixture-only additions — do not weaken existing assertions).
- Read-only: `lib/canon/store.ts` (`getSql`, `getOpportunityById`, `countOpportunities`, `closeStore`),
  `lib/canon/rules.ts` (`getEligibilityRules`, `EligibilityRuleRow`), `lib/eligibility/screen.ts`.

## Definition of done
- [ ] Test pulls a bounded sample of real opportunities READ-ONLY (e.g. `select id from opportunities …
      limit N`, and `getEligibilityRules(id)` per opp). No writes, no LLM. Uses `closeStore()` in teardown.
- [ ] Maps each `EligibilityRuleRow` → the engine's `ScreeningRule` shape (model_inferred, no predicate)
      and screens it against a small set of representative `CompanyProfile`s (e.g. a minimal profile and
      a fuller one) — asserting **no result has bucket `excluded`** and **no `failed_rules` entry across
      the whole sample**.
- [ ] Every determination round-trips through `EligibilityDeterminationSchema.parse` without throwing.
- [ ] Guard: if `FUNDFINDER_DB_PASSWORD` is missing OR a short-timeout connectivity probe fails, the
      test **skips** (node:test `{ skip: true }` / early return) and prints why — it must NOT fail the suite.
- [ ] Findings note committed with the observed numbers.

## Out of scope
- Any write to Supabase (READ-ONLY only). Modifying `screen.ts` production logic. Modifying the
  forbidden files (`match.ts`, `route.ts`, `IntakeForm.tsx`, `SearchProgress.tsx`). Rule extraction (CAN-04).

## Test plan
Run `npm test` with `FUNDFINDER_DB_PASSWORD` exported (in your shell, or set in `scaffold/.env.local`) so the integration test actually
hits the real corpus and reports the bucket distribution; then confirm it SKIPS cleanly when the var is
unset. Verify with `npx tsc --noEmit` + `npm test`.

## Escalate if (§8.3)
- Any real opportunity screens to `excluded`, or any `model_inferred` rule lands in `failed_rules` —
  that is a live R8.4 violation: STOP, capture the opportunity id + rule, and report to main.
