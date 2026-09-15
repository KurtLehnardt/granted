# Resolved Questions

## G7 — two honesty findings in the WS-G apply engine (FIXED)

Surfaced 2026-08-16 while building the G7 anti-fabrication/honesty eval
(`scaffold/lib/eval/__tests__/applicationHonesty.test.ts`). Both were originally
filed to `open-questions.md` and asserted as `// KNOWN FINDING:` tests (the eval
gate asserting the *buggy* behavior) because G7's scope was read-only for
`lib/apply/*`. **Both are now fixed** in PR `fix/apply-grounding-gaps`
(2026-09-15); the two tests were flipped from "assert the bug survives" to real
regression guards asserting the corrected behavior, and the standalone harness
`evals/application-honesty-eval.mjs` was updated to match.

### Finding 1 — `lib/apply/draft.ts`: an undeclared factual sentence bypassed grounding enforcement entirely

**Was:** `enforceGrounding` / `validateDraftGrounding` inspected only the model's
*declared* `claims` array. A factual-sounding sentence written directly into
`draft_text` with **no corresponding `claims` entry** (and no gap placeholder)
was invisible to both checks — so a model that forgot (or was induced) to
declare one `claims` entry shipped a specific, invented fact (a metric, a
customer count, a dollar figure) with no `[founder to provide: …]` marker at all.

**Fix:** added a deterministic **undeclared-sentence guard** to
`neutralizeSection` (runs as step 4.5, after declared-claim neutralization and
before the banned-phrase refusal) that accounts for the ENTIRE `draft_text`, not
just declared claims:

- Existing `[founder to provide: …]` placeholders are split out and preserved
  verbatim (so a wrapped sentence never nests one).
- Each remaining sentence has every surviving **grounded** `claims[].text` span
  removed; whatever is left is undeclared prose.
- **Rule:** if the residual still contains a specific quantitative token — a
  digit run (which subsumes counts, dollar figures, percentages, and years) —
  the whole sentence is an undeclared specific factual assertion and is
  **wrapped** into a `[founder to provide: verify or remove this unverified
  statement — "<sentence>"]` gap (registered in `gaps`, surfaced everywhere).
  It can no longer read as an asserted fact.
- Sentences with no leftover quantitative specific — connective/framing/
  transition prose (e.g. "This project will expand our reach…") — are
  **deliberately left untouched**. The guard **flags/wraps, never silently
  deletes**, and never touches non-factual framing (conservative on purpose:
  over-flagging a quantitative claim the model forgot to declare is still
  honest; mangling legitimate connective prose is not). Banned
  definitive-eligibility phrasing still throws (`findBannedPhrases` is a plain
  substring scan, so it fires even inside a wrapped sentence).

The repro (`SPARSE_SECTION_TRACTION.draft_text` — "Our platform now serves more
than 3,000 rural clinics nationwide." with no `claims` entry) is now wrapped and
surfaced in `pkg.gaps` rather than shipped bare.

### Finding 2 — `lib/apply/budget.ts`: template line-item gap placeholders were rendered but never collected into `budget.gaps`

**Was:** when `use_of_funds` is absent, `buildTemplateLineItems` embeds a
`[founder to provide: how funds will be used for <category>]` placeholder inside
each line item's `justification` (genuinely rendered), but `buildBudget` only
called `addGap(li.amount)` — never scanning `justification`. Up to 8 visibly
rendered founder-to-provide markers were silently absent from `budget.gaps`,
contradicting `applicationBudget.ts`'s own doc ("`gaps` is the flat,
deduplicated list of every distinct `[founder to provide: …]` placeholder
appearing anywhere in the package") and propagating into `collectAllGaps` /
`AssembledPackage.gaps`.

**Fix:** `buildBudget` now also scans each line item's `justification` with the
**same shared `scanFounderTodos` scanner** `collectAllGaps` uses on narrative
`draft_text`, adding every match to the gap set (deduped) in addition to the
amount gap.

### Shared-helper cleanup

The non-anchored inline scanner (`FOUNDER_TODO_SCAN` + `scanFounderTodos`) was
factored into `lib/contracts/applicationDraft.ts` (next to `FOUNDER_TODO_PATTERN`,
the single source of truth for the placeholder convention) and is now reused by
`draft.ts`, `budget.ts`, and `package.ts` (which re-exports it for its existing
importers — the `ApplicationPackage` component and the eval suites). Behavior is
identical to the three previously-duplicated local copies.

**Gates:** typecheck, `npm test` (866 pass / 0 fail / 1 pre-existing skip),
`npm run check:prompts`, `npm run build`, and the standalone
`evals/application-honesty-eval.mjs` (OVERALL: PASS, 0 known-finding drift) all
green.
