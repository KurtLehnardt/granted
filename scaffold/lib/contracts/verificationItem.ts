import { z } from "zod";

/**
 * §3.3 — VerificationItem
 *
 * `{ id, claim, classification, status, resolution?, source_url?,
 *    retrieved_at? }`. Drives R2's "Verify these for me".
 *
 * Classification is conservative by construction (R2 — "when in doubt it is
 * `user_only`"). A failed/ambiguous lookup downgrades to `user_only` rather than
 * fabricating a resolution.
 */

export const VerificationClassificationSchema = z.enum([
  /** Answerable by web search against an authoritative source in 1–2 lookups. */
  "auto_verifiable",
  /** Depends on facts only the user has. */
  "user_only",
  /** Needs a program officer or counsel; neither model nor search settles it. */
  "judgment",
]);
export type VerificationClassification = z.infer<
  typeof VerificationClassificationSchema
>;

export const VerificationStatusSchema = z.enum([
  "pending",
  "in_progress",
  "verified",
  /** Lookup failed or was ambiguous → the item is downgraded to user_only. */
  "failed",
  "ambiguous",
  "downgraded",
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationItemSchema = z
  .object({
    id: z.string(),
    /** The claim to be checked ("this program is still open"). */
    claim: z.string(),
    classification: VerificationClassificationSchema,
    status: VerificationStatusSchema.default("pending"),
    /**
     * The short resolved answer. Present only for a real `verified` result;
     * never a fabricated one (R2 — a failed lookup produces no resolution, it
     * degrades).
     */
    resolution: z.string().optional(),
    /** Authoritative source link — mandatory before an item renders as verified. */
    source_url: z.string().url().optional(),
    /** ISO-8601 retrieval timestamp shown next to a verified result (R2). */
    retrieved_at: z.string().datetime().optional(),
    /** Suggested next step for `judgment` items ("contact the program officer"). */
    suggested_next_step: z.string().optional(),
  })
  /**
   * R2 acceptance: "no verification result renders without a source link." A
   * `verified` item MUST carry a `source_url` — the schema forbids a verified
   * claim with no source.
   */
  .refine((v) => v.status !== "verified" || !!v.source_url, {
    message: "A verified item must carry a source_url (R2).",
    path: ["source_url"],
  });
export type VerificationItem = z.infer<typeof VerificationItemSchema>;
