# Resolved Questions

## G7 — two honesty findings in the WS-G apply engine (FIXED)

Surfaced 2026-08-16 while building the G7 anti-fabrication/honesty eval
(`scaffold/lib/eval/__tests__/applicationHonesty.test.ts`). Both were originally
filed to `open-questions.md` and asserted as `// KNOWN FINDING:` tests (the eval
gate asserting the *buggy* behavior) because G7's scope was read-only for
`lib/apply/*`. **Both are now fixed** in PR `fix/apply-grounding-gaps`
(2026-09-15, https://github.com/KurtLehnardt/granted/pull/152); the two tests
were flipped from "assert the bug survives" to real
regression guards asserting the corrected behavior, and the standalone harness
`evals/application-honesty-eval.mjs` was updated to match.

### Finding 1 — `lib/apply/draft.ts`: an undeclared factual sentence bypassed grounding enforcement entirely

**Was:** `enforceGrounding` / `validateDraftGrounding` inspected only the model's
*declared* `claims` array. A factual-sounding sentence written directly into
`draft_text` with **no corresponding `claims` entry** (and no gap placeholder)
was invisible to both checks — so a model that forgot (or was induced) to
declare one `claims` entry shipped a specific, invented fact (a metric, a
customer count, a dollar figure) with no `[founder to provide: …]` marker at all.

**Fix:** added a deterministic **undeclared specific-quantitative guard** to
`neutralizeSection` (runs as step 4.5, after declared-claim neutralization and
before the banned-phrase refusal) that accounts for the ENTIRE `draft_text`, not
just declared claims. The guard is deliberately NARROW and robust — it runs on
every production draft, so it must never mangle legitimate prose:

- **Detector (high-signal only):** a sentence is wrapped only when it carries a
  high-signal specific-quantitative token — a `$`-amount (with K/M/B, commas,
  decimals), an `N%` percentage, or a comma-grouped number like `3,000`. Bare
  integers, ratios/identifiers (`24/7`), reference cites (`Section 508`,
  `No. 12`, `§`), and 4-digit years are explicitly EXCLUDED. A purely
  QUALITATIVE undeclared claim ("we are the market leader") carries no
  quantitative signal and is out of scope (documented in the module header, no
  longer overclaimed).
- **Grounded-number tolerance:** the sentence is left alone when every
  quantitative token in it also appears — compared by NUMBER, not verbatim
  substring — in some surviving grounded `claims[].text`. So a declared
  "3,000 rural clinics" claim protects the paraphrase "over 3,000 rural clinics".
- **Wrap in place:** only the offending sentence's own character span is replaced
  by `[founder to provide: verify or remove this unverified statement —
  "<sentence>"]` (registered in `gaps`, surfaced everywhere); all other prose and
  ALL whitespace/newlines are preserved byte-for-byte, and when nothing is
  wrapped the draft is returned unchanged (no paragraph flattening).
- **Abbreviation-safe boundaries:** sentence splitting does not break inside
  common abbreviations (`U.S.`, `e.g.`, `i.e.`, `Inc.`, `St.`, …), so a
  legitimate sentence is never fragmented mid-abbreviation; existing
  `[founder to provide: …]` placeholders are skipped so a wrapped sentence never
  nests one.
- The guard **flags/wraps, never silently deletes**. Banned
  definitive-eligibility phrasing still throws (`findBannedPhrases` is a plain
  substring scan, so it fires even inside a wrapped sentence).

The repro (`SPARSE_SECTION_TRACTION.draft_text` — "Our platform now serves more
than 3,000 rural clinics nationwide." with no `claims` entry) is now wrapped and
surfaced in `pkg.gaps` rather than shipped bare. A `Finding-1 guard` robustness
test suite (in `applicationHonesty.test.ts`) locks in the must-NOT-wrap fixtures
(Section 508, "3 years", 24/7, "U.S. Government on 12 pilot sites", grounded
paraphrase, multi-paragraph whitespace) alongside the must-wrap cases.

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

**Gates:** typecheck, `npm test` (874 pass / 0 fail / 1 pre-existing skip),
`npm run check:prompts`, `npm run build`, and the standalone
`evals/application-honesty-eval.mjs` (OVERALL: PASS, 0 known-finding drift) all
green.
