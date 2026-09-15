// ============================================================================
// G7 — application-honesty eval (root-level harness).
// ----------------------------------------------------------------------------
// Mirrors the invariant checks in
// `scaffold/lib/eval/__tests__/applicationHonesty.test.ts` (the `npm test`
// gate that actually enforces these — this script is a convenience runner
// over the SAME golden fixtures + the SAME real apply-engine functions, for
// running/inspecting the eval standalone from the repo root, the same way
// `false-exclusion-eval.mjs` / `interview-eval.mjs` do for EVL-03).
//
// Pure logic, NO LLM calls, NO network. Everything is deterministic:
//   - `scaffold/lib/eval/applicationGolden.ts` — the golden founder profiles +
//     opportunities + simulated raw (pre-enforcement) G2 model output.
//   - `scaffold/lib/apply/draft.ts` — the REAL `enforceGrounding` /
//     `validateDraftGrounding` (anti-fabrication enforcement).
//   - `scaffold/lib/apply/forms.ts` / `budget.ts` / `package.ts` — the REAL
//     deterministic SF-424 pre-fill, budget builder, and package assembler.
//
// Run (tsx is a `scaffold/` devDependency, so `cd scaffold` first — same
// requirement `npm test` already has via `scaffold/package.json`):
//   cd scaffold && node --import tsx ../evals/application-honesty-eval.mjs
//
// Exit code: 0 only if all four honesty invariants hold over every golden
// case AND the two FORMERLY-known findings (draft.ts undeclared-sentence guard
// + budget.ts justification gap-collection, fixed in PR fix/apply-grounding-gaps
// — see resolved-questions.md §G7) still hold in their FIXED state. The two
// `known-finding` records below now assert the corrected behavior, so this
// script fails loudly if either fix is reverted or silently regresses. A
// nonzero exit means either a genuine invariant violation was found, or one of
// the two guarded fixes has drifted from its documented (fixed) state.
// ============================================================================

import {
  APPLICATION_GOLDEN_CASES,
  SPARSE_CASE,
  NO_TRACTION_CASE,
  RICH_CASE,
  BANNED_PHRASE_ATTEMPT_CASE,
} from "../scaffold/lib/eval/applicationGolden.ts";
import { enforceGrounding, validateDraftGrounding, DraftGroundingError } from "../scaffold/lib/apply/draft.ts";
import { prefillApplicationForms } from "../scaffold/lib/apply/forms.ts";
import { buildBudget } from "../scaffold/lib/apply/budget.ts";
import {
  assemblePackage,
  scanFounderTodos,
  allRegistrationsSatisfied,
  AOR_HANDOFF,
  PACKAGE_INTRO,
} from "../scaffold/lib/apply/package.ts";
import { ApplicationDraftSchema, FOUNDER_TODO_PATTERN } from "../scaffold/lib/contracts/applicationDraft.ts";
import { isFieldProvided } from "../scaffold/lib/contracts/companyProfile.ts";
import { findBannedPhrases } from "../scaffold/scripts/banned-phrases.mjs";

const results = [];
function record(section, name, pass, detail) {
  results.push({ section, name, pass, detail });
  const mark = pass === null ? "N/A " : pass ? "PASS" : "FAIL";
  console.log(`  ${mark}  [${section}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const SUBMIT_CONFIRMATION_PATTERNS = [
  /application (has been |was )?submitted\b/i,
  /we (have |)submitted/i,
  /automatically submit/i,
  /you('ve| have) won\b/i,
  /application (was |has been )?approved\b/i,
  /(?<!no )application (was |has been )?filed\b/i,
  /\bawarded\b/i,
  /you (are|'re) eligible/i,
  /you qualify/i,
  /this application (is|has been) (funded|awarded)\b/i,
];

function preEnforcementDraft(goldenCase) {
  return {
    opportunity_id: goldenCase.opportunity.id,
    program_title: goldenCase.opportunity.title ?? goldenCase.opportunity.program,
    generated_at: new Date().toISOString(),
    sections: goldenCase.rawSections.map((s) => ({
      key: s.key,
      title: s.title,
      prompt: s.prompt,
      draft_text: s.draft_text,
      claims: s.claims,
      gaps: s.gaps,
    })),
  };
}

function enforcedDraft(goldenCase) {
  return ApplicationDraftSchema.parse(enforceGrounding(preEnforcementDraft(goldenCase), goldenCase.profile));
}

function assembleGoldenPackage(goldenCase) {
  const draft = enforcedDraft(goldenCase);
  const forms = prefillApplicationForms(goldenCase.profile, goldenCase.reqs, goldenCase.opportunity);
  const budget = buildBudget(goldenCase.profile, undefined, goldenCase.opportunity);
  return assemblePackage({
    opportunity_id: goldenCase.opportunity.id,
    program_title: goldenCase.opportunity.title ?? goldenCase.opportunity.program,
    forms,
    budget,
    checklist: { allRegistrationsSatisfied: allRegistrationsSatisfied(goldenCase.reqs) },
    narrativeSections: goldenCase.narrativeSections,
    draft,
    narrativeStatus: "drafted",
    requirementsAvailable: true,
  });
}

function allVisibleText(pkg) {
  const narrative = pkg.narratives.map((s) => s.draft_text).join(" ");
  const formsText = pkg.forms.forms.flatMap((f) => f.fields.map((field) => field.display)).join(" ");
  const budgetText = [
    ...pkg.budget.line_items.map((li) => li.justification),
    ...pkg.budget.notes,
    ...pkg.budget.advisories,
    pkg.budget.total.range_statement,
    ...pkg.budget.constraints.map((c) => c.note),
  ].join(" ");
  return [narrative, formsText, budgetText].join(" ");
}

console.log("=".repeat(78));
console.log("G7 — application-honesty eval");
console.log("=".repeat(78));

// ---------------------------------------------------------------------------
// Invariant 1 — no fabrication
// ---------------------------------------------------------------------------
console.log("\n--- Invariant 1: no fabrication (grounded or gapped) ---");
for (const c of APPLICATION_GOLDEN_CASES) {
  const raw = preEnforcementDraft(c);
  const pre = validateDraftGrounding(raw, c.profile);
  if (c.hasDeclaredFabricationRisk) {
    record("fab-precheck", `${c.id}: raw draft correctly fails grounding pre-enforcement`, pre.grounded === false, pre.grounded ? "expected a fabrication-risk issue" : undefined);
  } else {
    record("fab-precheck", `${c.id}: raw draft already grounded (no fabrication attempted)`, pre.grounded === true, pre.grounded ? undefined : pre.issues.join("; "));
  }
  const enforced = enforceGrounding(raw, c.profile);
  const post = validateDraftGrounding(enforced, c.profile);
  record("fab-postcheck", `${c.id}: post-enforcement draft is grounded`, post.grounded === true, post.grounded ? undefined : post.issues.join("; "));
  let claimsOk = true;
  for (const section of enforced.sections) {
    for (const claim of section.claims) {
      if (!isFieldProvided(c.profile, claim.profile_field)) claimsOk = false;
    }
  }
  record("fab-claims", `${c.id}: every surviving claim cites a provided field`, claimsOk);
}

// FIXED — Finding 1 (lib/apply/draft.ts): the undeclared-sentence guard wraps an
// undeclared factual sentence into a [founder to provide: …] marker instead of
// shipping it as a bare assertion, and surfaces it in pkg.gaps.
{
  const enforced = enforcedDraft(SPARSE_CASE);
  const traction = enforced.sections.find((s) => s.key === "traction_and_impact");
  const withoutMarkers = traction.draft_text.replace(/\[founder to provide: [^\]]+\]/g, "");
  const noLongerBareAssertion = !/Our platform now serves more than 3,000/.test(withoutMarkers);
  const nowWrapped = /\[founder to provide: [^\]]*Our platform now serves more than 3,000 rural clinics nationwide[^\]]*\]/.test(traction.draft_text);
  const pkg = assembleGoldenPackage(SPARSE_CASE);
  const surfacedInGaps = pkg.gaps.some((g) => /Our platform now serves more than 3,000 rural clinics nationwide/.test(g));
  const check = validateDraftGrounding(enforced, SPARSE_CASE.profile);
  record(
    "known-finding",
    "draft.ts (FIXED): an UNDECLARED factual sentence is wrapped into a [founder to provide] marker, surfaced in pkg.gaps, and the draft still validates as grounded",
    noLongerBareAssertion && nowWrapped && surfacedInGaps && check.grounded === true,
    "fixed in PR fix/apply-grounding-gaps; see resolved-questions.md §G7",
  );
}

// ---------------------------------------------------------------------------
// Invariant 2 — never claims submission/award/eligibility
// ---------------------------------------------------------------------------
console.log("\n--- Invariant 2: never claims submission/award/eligibility ---");
for (const c of APPLICATION_GOLDEN_CASES) {
  const pkg = assembleGoldenPackage(c);
  const text = allVisibleText(pkg);
  const banned = findBannedPhrases(text);
  const forbidden = SUBMIT_CONFIRMATION_PATTERNS.filter((re) => re.test(text));
  record(
    "no-submission-claim",
    `${c.id}: assembled package has no banned/forbidden phrasing`,
    banned.length === 0 && forbidden.length === 0,
    [...banned, ...forbidden.map(String)].join(", ") || undefined,
  );
}
{
  const copy = [AOR_HANDOFF.eyebrow, AOR_HANDOFF.headline, AOR_HANDOFF.body, AOR_HANDOFF.cta, PACKAGE_INTRO.eyebrow, PACKAGE_INTRO.note].join(" ");
  const banned = findBannedPhrases(copy);
  const forbidden = SUBMIT_CONFIRMATION_PATTERNS.filter((re) => re.test(copy));
  record("no-submission-claim", "AOR_HANDOFF/PACKAGE_INTRO honest copy is clean", banned.length === 0 && forbidden.length === 0);
}
{
  let threw = false;
  try {
    enforceGrounding(preEnforcementDraft(BANNED_PHRASE_ATTEMPT_CASE), BANNED_PHRASE_ATTEMPT_CASE.profile);
  } catch (err) {
    threw = err instanceof DraftGroundingError;
  }
  record("no-submission-claim", "adversarial eligibility assertion is REFUSED (thrown), never shipped", threw);
}

// ---------------------------------------------------------------------------
// Invariant 3 — every genuine gap surfaces a marker
// ---------------------------------------------------------------------------
console.log("\n--- Invariant 3: every genuine gap surfaces a [founder to provide] marker ---");
for (const c of APPLICATION_GOLDEN_CASES) {
  const pkg = assembleGoldenPackage(c);
  const nonEmpty = pkg.gaps.length > 0;
  const wellFormed = pkg.gaps.every((g) => FOUNDER_TODO_PATTERN.test(g));
  const inline = pkg.narratives.flatMap((s) => scanFounderTodos(s.draft_text));
  const inlineCovered = inline.every((ph) => pkg.gaps.includes(ph));
  record("gap-surfacing", `${c.id}: pkg.gaps non-empty, well-formed, covers every inline narrative placeholder`, nonEmpty && wellFormed && inlineCovered);
}

// FIXED — Finding 2 (lib/apply/budget.ts): justification placeholders are now
// collected into budget.gaps (and therefore into pkg.gaps).
{
  const budget = buildBudget(SPARSE_CASE.profile, undefined, SPARSE_CASE.opportunity);
  const justificationText = budget.line_items.map((li) => li.justification).join(" | ");
  const rendered = scanFounderTodos(justificationText);
  const allCollected = rendered.length > 0 && rendered.every((ph) => budget.gaps.includes(ph));
  const pkg = assembleGoldenPackage(SPARSE_CASE);
  const allInPackage = rendered.every((ph) => pkg.gaps.includes(ph));
  record(
    "known-finding",
    "budget.ts (FIXED): template line-item justification placeholders (use_of_funds absent) ARE collected into budget.gaps and surface in pkg.gaps",
    allCollected && allInPackage,
    "fixed in PR fix/apply-grounding-gaps; see resolved-questions.md §G7",
  );
}

// ---------------------------------------------------------------------------
// Invariant 4 — sparser profiles yield more gaps
// ---------------------------------------------------------------------------
console.log("\n--- Invariant 4: sparser profiles yield more gaps ---");
{
  const sparse = assembleGoldenPackage(SPARSE_CASE);
  const noTraction = assembleGoldenPackage(NO_TRACTION_CASE);
  const rich = assembleGoldenPackage(RICH_CASE);
  record(
    "gap-count-ordering",
    `sparse (${sparse.gaps.length}) > no-traction (${noTraction.gaps.length}) > rich (${rich.gaps.length})`,
    sparse.gaps.length > rich.gaps.length && noTraction.gaps.length > rich.gaps.length && sparse.gaps.length >= noTraction.gaps.length,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("SUMMARY");
console.log("=".repeat(78));

const bySection = {};
for (const r of results) {
  bySection[r.section] ??= { pass: 0, fail: 0 };
  if (r.pass) bySection[r.section].pass++;
  else bySection[r.section].fail++;
}
for (const [section, counts] of Object.entries(bySection)) {
  console.log(`  ${section}: ${counts.pass} pass, ${counts.fail} fail`);
}

const invariantFailures = results.filter((r) => r.section !== "known-finding" && !r.pass);
const knownFindingDrift = results.filter((r) => r.section === "known-finding" && !r.pass);

console.log(`\nInvariant failures: ${invariantFailures.length} (must be 0)`);
for (const f of invariantFailures) console.log(`    - [${f.section}] ${f.name}: ${f.detail ?? ""}`);
console.log(`Known-finding drift: ${knownFindingDrift.length} (must be 0 — a nonzero count means a documented finding changed state; update open-questions.md/PR + this script)`);
for (const f of knownFindingDrift) console.log(`    - [${f.section}] ${f.name}`);

const overallPass = invariantFailures.length === 0 && knownFindingDrift.length === 0;
console.log(`\nOVERALL: ${overallPass ? "PASS" : "FAIL"}`);
console.log("=".repeat(78));

process.exitCode = overallPass ? 0 : 1;
