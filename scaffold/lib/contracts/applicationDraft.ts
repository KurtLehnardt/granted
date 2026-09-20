import { z } from "zod";

/**
 * WS-G / G2 — ApplicationDraft (the grounded narrative draft package produced
 * from a user's `CompanyProfile` + G1's `ApplicationRequirements`).
 *
 * THE HONESTY CONTRACT (R7.7 — mirrors G1's `applicationRequirements.ts` and
 * `lib/eligibility/screen.ts`): every sentence in a drafted section that makes a
 * FACTUAL claim is one of exactly two things —
 *   (a) GROUNDED — it appears in `claims` with the exact `profile_field` key it
 *       came from, and that field is actually provided on the profile
 *       (`isFieldProvided`); or
 *   (b) A GAP — an inline `[you to provide: …]` placeholder in `draft_text`,
 *       recorded in `gaps`.
 *
 * A specific fact is NEVER invented. A profile missing `revenue` yields
 * `[you to provide: annual revenue]`, never a made-up number. The drafter
 * (`lib/apply/draft.ts`) enforces this in a PURE, model-free validator
 * (`validateDraftGrounding`) and neutralizes any ungrounded claim into a gap
 * before this schema ever sees it — exactly as G1's `annotateGrounding` +
 * `ApplicationRequirementsSchema.parse(...)` do for extraction, and as
 * `screen()`'s `EligibilityDeterminationSchema.parse(...)` does for eligibility.
 */

/**
 * The exact shape every you-to-provide placeholder must take. Anchored so a
 * `gap.placeholder` is the WHOLE string (`[you to provide: <plain text>]`).
 * Consumers scanning `draft_text` for inline occurrences build a global,
 * non-anchored variant from the same literal shape (see `lib/apply/draft.ts`).
 * NEVER loosen this: it is what proves the drafter refused to fabricate a fact
 * and left an honest, fillable blank instead.
 */
export const FOUNDER_TODO_PATTERN = /^\[you to provide: .+\]$/;

/**
 * Global, NON-anchored companion to `FOUNDER_TODO_PATTERN`: FINDS every inline
 * `[you to provide: …]` occurrence inside a larger body of text (whereas the
 * anchored pattern validates that a WHOLE string is a single placeholder).
 * `[^\]]+` isolates each occurrence so two adjacent placeholders never merge into
 * one match. Defined ONCE here — the single source of truth for the placeholder
 * convention — and reused verbatim by every WS-G surface that scans prose for
 * gaps (`lib/apply/draft.ts` grounding enforcement, `lib/apply/budget.ts`
 * line-item justifications, `lib/apply/package.ts` gap collection) so they can
 * never drift apart. Consumers that need statefully-executable matches (e.g. the
 * renderer's `RegExp.exec` loop) build a fresh `RegExp` from `.source`.
 */
export const FOUNDER_TODO_SCAN = /\[you to provide: [^\]]+\]/g;

/** Every inline `[you to provide: …]` string present in `text`, in order. */
export function scanFounderTodos(text: string): string[] {
  return text.match(FOUNDER_TODO_SCAN) ?? [];
}

/**
 * One grounded factual sentence and the profile field key it rests on. The
 * `profile_field` MUST be a key for which `isFieldProvided(profile, key)` is
 * true — a claim citing an absent field is a fabrication risk and is caught by
 * `validateDraftGrounding` clause (a).
 */
export const DraftClaimSchema = z.object({
  /** The exact factual sentence as it appears in `draft_text`. */
  text: z.string(),
  /** The `CompanyProfile` field key this sentence is grounded in. */
  profile_field: z.string(),
});
export type DraftClaim = z.infer<typeof DraftClaimSchema>;

/**
 * A fact the profile does not provide, surfaced as a fillable blank rather than
 * invented. `placeholder` is the exact `[you to provide: …]` string that
 * appears inline in `draft_text`, and MUST match `FOUNDER_TODO_PATTERN`.
 */
export const DraftGapSchema = z.object({
  /** Short plain description of the missing fact (e.g. "annual revenue"). */
  field_hint: z.string(),
  /** The exact inline placeholder string; must match `FOUNDER_TODO_PATTERN`. */
  placeholder: z.string().regex(FOUNDER_TODO_PATTERN),
});
export type DraftGap = z.infer<typeof DraftGapSchema>;

/**
 * One drafted narrative section, keyed to a G1 `NarrativeSection`. `draft_text`
 * is the assembled narrative: grounded sentences (each mirrored in `claims`)
 * interleaved with inline `[you to provide: …]` placeholders (each mirrored
 * in `gaps`). `key`/`title`/`prompt` are carried over verbatim from the G1
 * section this answers.
 */
export const DraftSectionSchema = z.object({
  /** Stable slug carried from the G1 `NarrativeSection.key`. */
  key: z.string(),
  /** Human title carried from the G1 `NarrativeSection.title`. */
  title: z.string(),
  /** The instruction/question this section answers (G1 `NarrativeSection.prompt`). */
  prompt: z.string(),
  /** The assembled narrative — grounded sentences + inline gap placeholders. */
  draft_text: z.string(),
  claims: z.array(DraftClaimSchema).default([]),
  gaps: z.array(DraftGapSchema).default([]),
});
export type DraftSection = z.infer<typeof DraftSectionSchema>;

/**
 * The full grounded draft package for one opportunity. Top-level metadata
 * (`opportunity_id`, `program_title`) is carried from the G1
 * `ApplicationRequirements`; `generated_at` is stamped by the drafter.
 */
export const ApplicationDraftSchema = z.object({
  opportunity_id: z.string(),
  program_title: z.string(),
  /** ISO-8601 timestamp of when this draft was generated. */
  generated_at: z.string().datetime(),
  sections: z.array(DraftSectionSchema).default([]),
});
export type ApplicationDraft = z.infer<typeof ApplicationDraftSchema>;
