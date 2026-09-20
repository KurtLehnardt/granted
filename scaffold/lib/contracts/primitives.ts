import { z } from "zod";

/**
 * Shared primitive building blocks for the §3 contracts.
 *
 * These are NOT one of the twelve §3 contracts themselves — they are the small
 * reusable pieces (provenance, confidence, citations, timestamps) that several
 * contracts depend on. Kept in one place so `companyProfile`, `opportunity`,
 * `eligibilityDetermination`, and `verificationItem` share a single definition
 * rather than drifting.
 *
 * No design values (hex, spacing) live here — those are CON-02.
 */

/**
 * Provenance — how a fact came to be known. This is the calibration backbone of
 * the whole product (§11 "never let a model inference wear the costume of a
 * verified fact"). R2, R3, R8, and R6's attest screen all branch on it.
 *
 * - `user_stated`    — the user said it.
 * - `model_inferred` — the model guessed/derived it; never sufficient to gate an
 *                      exclusion on its own (R8.4).
 * - `verified`       — confirmed against an authoritative source (R2).
 */
export const ProvenanceSchema = z.enum([
  "user_stated",
  "model_inferred",
  "verified",
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Model/lookup confidence, normalized 0..1. */
export const ConfidenceSchema = z.number().min(0).max(1);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * Wrap a value schema so it can never exist without provenance + confidence.
 * A `Provenanced<T>` field is structurally impossible to construct without
 * saying where it came from — this is how `CompanyProfile` makes provenance
 * mandatory on every field.
 */
export function provenanced<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    provenance: ProvenanceSchema,
    confidence: ConfidenceSchema,
  });
}
export type Provenanced<T> = {
  value: T;
  provenance: Provenance;
  confidence: Confidence;
};

/**
 * A citation back to an authoritative source. Attached to eligibility rules
 * (R8.4 — "each with a citation to the NOFO or program page it came from") and
 * to verification resolutions (R2).
 */
export const CitationSchema = z.object({
  /** The source page / document, if there is a fetchable URL. */
  source_url: z.string().url().optional(),
  /** Human-readable source name ("Grants.gov NOFO HHS-2025-...", "SBA 13 CFR 121"). */
  source_name: z.string().optional(),
  /** ISO-8601 timestamp for when this was retrieved. Freshness (R8.3, §4.4). */
  retrieved_at: z.string().datetime().optional(),
  /** The exact quoted text the claim rests on, if applicable. */
  quote: z.string().optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

/** ISO-8601 datetime string (e.g. retrieval / created timestamps). */
export const IsoTimestampSchema = z.string().datetime();
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Epoch milliseconds (used by `ProgressEvent.ts`, elapsed timers). */
export const EpochMillisSchema = z.number().int().nonnegative();
export type EpochMillis = z.infer<typeof EpochMillisSchema>;
