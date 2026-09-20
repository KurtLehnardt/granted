import { z } from "zod";
import { FOUNDER_TODO_PATTERN } from "./applicationDraft";

/**
 * VENDORED COPY of `scaffold/lib/contracts/applicationForms.ts`.
 *
 * Kept byte-for-byte equivalent (see `test/contractDrift.test.ts`). This is
 * the LOAD-BEARING honesty gate the import pipeline (`packageValidator.ts`,
 * spec §6.3 step 5) re-runs against `payload.forms` on every import: it
 * re-executes the exact same `superRefine` anti-fabrication checks the app
 * used to produce the package, so a tampered or malformed package cannot
 * pass extension-side validation just because it passed on the app side.
 *
 * WS-G / G3 — PrefilledForms (the deterministic SF-424 federal-application
 * pre-fill produced from a user's `CompanyProfile` + the mock SAM/UEI
 * settings + the matched `Opportunity`).
 *
 * THE HONESTY CONTRACT (R7.7 — mirrors G1's `applicationRequirements.ts`, G2's
 * `applicationDraft.ts`, and `lib/eligibility/screen.ts`): every emitted field
 * is EXACTLY one of two things —
 *   (a) GROUNDED — `status: "prefilled"`, a real `value`, and a `source` string
 *       naming precisely where the value came from (e.g. `"sam.uei"`,
 *       `"profile.naics_codes"`, `"opportunity.agency"`). Its `display` is the
 *       human value and is NEVER a `[you to provide: …]` placeholder; or
 *   (b) A GAP — `status: "founder_to_provide"`, NO `value`, NO `source`, and a
 *       `display` that is the exact `[you to provide: <hint>]` string
 *       matching `FOUNDER_TODO_PATTERN`.
 *
 * A specific fact (org name, project title, exact dollar amount, project dates)
 * is NEVER invented. The mapper (`lib/apply/forms.ts`) is a PURE, model-free
 * deterministic function — there is nothing to hallucinate a value from — and it
 * validates its output through `PrefilledFormsSchema.parse(...)` as
 * defense-in-depth, exactly as G1's `ApplicationRequirementsSchema.parse` and
 * G2's `ApplicationDraftSchema.parse` do.
 *
 * `FOUNDER_TODO_PATTERN` is REUSED from `applicationDraft.ts` (not re-defined) so
 * G5 can scan every WS-G surface — narrative drafts AND form pre-fills — for
 * fillable blanks with ONE convention.
 */

/** A pre-filled field is either grounded (`prefilled`) or a fillable blank. */
export const PrefilledFieldStatusSchema = z.enum(["prefilled", "founder_to_provide"]);
export type PrefilledFieldStatus = z.infer<typeof PrefilledFieldStatusSchema>;

/**
 * One SF-424 field. The `superRefine` is the load-bearing anti-fabrication gate:
 * it makes a grounded field structurally require a `source` + `value` (so no
 * value can appear without saying where it came from), and makes a gap
 * structurally forbid `value`/`source` while forcing its `display` to the exact
 * `[you to provide: …]` shape (so a made-up placeholder cannot pass). There
 * is no valid shape carrying an invented value with no provenance.
 */
export const PrefilledFieldSchema = z
  .object({
    /** Stable machine key for the SF-424 field (e.g. `"uei"`, `"project_title"`). */
    key: z.string().min(1),
    /** User-facing label (e.g. "Unique Entity Identifier (UEI)"). */
    label: z.string().min(1),
    status: PrefilledFieldStatusSchema,
    /** The underlying grounded value. Present iff `status === "prefilled"`. */
    value: z.string().optional(),
    /**
     * The human-facing string. For a grounded field it is the value as shown to
     * the user; for a gap it is the exact `[you to provide: …]` placeholder.
     */
    display: z.string().min(1),
    /**
     * Where a grounded value came from (e.g. `"sam.uei"`, `"profile.location"`,
     * `"opportunity.agency"`). Present iff `status === "prefilled"`.
     */
    source: z.string().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.status === "prefilled") {
      // A grounded field MUST carry a real value and name its source.
      if (f.value === undefined || f.value.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `prefilled field "${f.key}" must carry a non-empty value`,
          path: ["value"],
        });
      }
      if (f.source === undefined || f.source.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `prefilled field "${f.key}" must name a source (grounding is mandatory)`,
          path: ["source"],
        });
      }
      // A grounded display is a human value, never a fillable-blank placeholder.
      if (FOUNDER_TODO_PATTERN.test(f.display)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `prefilled field "${f.key}" display must not be a [you to provide: …] placeholder`,
          path: ["display"],
        });
      }
    } else {
      // A gap NEVER carries a value or a source — nothing was grounded.
      if (f.value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gap field "${f.key}" must not carry a value`,
          path: ["value"],
        });
      }
      if (f.source !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gap field "${f.key}" must not carry a source`,
          path: ["source"],
        });
      }
      // A gap's display is the exact `[you to provide: <hint>]` string.
      if (!FOUNDER_TODO_PATTERN.test(f.display)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gap field "${f.key}" display ${JSON.stringify(f.display)} must match the [you to provide: …] shape`,
          path: ["display"],
        });
      }
    }
  });
export type PrefilledField = z.infer<typeof PrefilledFieldSchema>;

/** One fillable federal form (e.g. the SF-424) and its pre-filled fields. */
export const PrefilledFormSchema = z.object({
  /** The form's official name (e.g. `"SF-424"`). */
  form_name: z.string().min(1),
  fields: z.array(PrefilledFieldSchema).default([]),
});
export type PrefilledForm = z.infer<typeof PrefilledFormSchema>;

/**
 * The full pre-fill package for one opportunity. `gaps` is the DERIVED list of
 * every `[you to provide: …]` placeholder across every form — the single
 * surface G5 highlights. The `superRefine` guarantees `gaps` is exactly the set
 * of gap `display`s (no missing or invented entries) and that each one matches
 * `FOUNDER_TODO_PATTERN`.
 */
export const PrefilledFormsSchema = z
  .object({
    /** The `Opportunity.id` these forms were pre-filled for. */
    opportunity_id: z.string().min(1),
    /** The program's title (carried from the `Opportunity`). */
    program_title: z.string().min(1),
    /** ISO-8601 timestamp of when this pre-fill was generated. */
    generated_at: z.string().datetime(),
    forms: z.array(PrefilledFormSchema).default([]),
    /** Every `[you to provide: …]` placeholder across all forms (for G5). */
    gaps: z.array(z.string()).default([]),
  })
  .superRefine((pkg, ctx) => {
    // Every declared gap must be a real fillable-blank placeholder.
    pkg.gaps.forEach((g, i) => {
      if (!FOUNDER_TODO_PATTERN.test(g)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gaps[${i}] ${JSON.stringify(g)} does not match the [you to provide: …] shape`,
          path: ["gaps", i],
        });
      }
    });

    // `gaps` must be EXACTLY the displays of every founder_to_provide field —
    // no gap silently dropped, none invented. G5 relies on this completeness.
    const derived = pkg.forms
      .flatMap((f) => f.fields)
      .filter((f) => f.status === "founder_to_provide")
      .map((f) => f.display)
      .sort();
    const declared = [...pkg.gaps].sort();
    const mismatch =
      derived.length !== declared.length ||
      derived.some((g, i) => g !== declared[i]);
    if (mismatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "gaps must list exactly every [you to provide: …] placeholder across all forms",
        path: ["gaps"],
      });
    }
  });
export type PrefilledForms = z.infer<typeof PrefilledFormsSchema>;
