import { z } from "zod";

/**
 * WS-G / G6 — S2S core contracts (types + honesty guarantees).
 *
 * G6 adds the deterministic "plumbing" a submission-ready package would travel
 * through to reach grants.gov — an XML mapping, a typed client with a pluggable
 * transport, a per-org credential model, and an AOR-authorization gate — and
 * exercises the whole thing end-to-end against a MOCK transport ONLY. G6 never
 * submits anything to any federal system (spec §1, §10; memo §7).
 *
 * THE HONESTY CONTRACT (spec §10, §4.2 HR-1…HR-6 — mirrors the grounded
 * `applicationDraft.ts` / `applicationRequirements.ts` discipline):
 *   - No fabrication. A fact the record does not carry becomes `undefined`
 *     (a gap the downstream XML mapper renders as a visible marker), NEVER a
 *     guessed value. See `SubmissionMeta`'s optional ids.
 *   - Every receipt G6 can ever produce is a MOCK receipt: `is_mock: true` and
 *     `submitted_to: "MOCK"`. The schema enforces this with `z.literal(...)`,
 *     so a non-mock receipt cannot even be constructed here (HR-3).
 *   - The AOR gate records an ATTESTATION, never a credential. `attested` is a
 *     `z.literal(true)` — an unchecked box is simply the ABSENCE of an
 *     authorization, so a `false`/missing attestation cannot parse (HR-4, §6.1).
 *
 * Every schema below carries a `.parse()` seam used as defense-in-depth by the
 * pure functions that build these values (mirroring how G1/G2 call
 * `Schema.parse(...)` after their model-free grounding enforcers). These are
 * plain data contracts: no model call, no network, no side effects.
 */

// ---------------------------------------------------------------------------
// Transport kind
// ---------------------------------------------------------------------------

/**
 * Which transport a submission would travel through. G6 wires ONLY `"mock"`:
 * `selectTransport("sandbox"|"live")` throws (T-C, FR-5), and no `LiveTransport`
 * symbol exists anywhere in `lib/s2s`. `"sandbox"`/`"live"` are named here purely
 * so the guarded, unwired seam is typed — never so it can fire (spec §6, §10.2).
 */
export type TransportKind = "mock" | "sandbox" | "live";

// ---------------------------------------------------------------------------
// AOR authorization — an attestation record, NOT a credential
// ---------------------------------------------------------------------------

/**
 * A recorded per-package attestation that a named human Authorized Organization
 * Representative (AOR) OF THE ORG reviewed the assembled package and attested to
 * its accuracy (spec §6.1; the code embodiment of the memo's "human
 * review-and-attest, the human is the AOR" boundary).
 *
 * This holds NO credentials — no password, no session token, no SAM.gov /
 * Grants.gov secret of any kind (NG-3, memo §7 E2). It is analogous to
 * `AutoFillRequirements.aorOnFile`, but scoped to one opportunity and
 * timestamped.
 *
 *   - `attested` is `z.literal(true)`: an UNCHECKED box is the absence of an
 *     authorization, not a `false` authorization — a record with `attested:false`
 *     (or missing) is refused by the schema, which is what makes the gate honest.
 *   - `aor_name` is self-reported (provenance is `user_stated` by construction);
 *     it feeds the attestation record only, never an authentication step.
 *   - `is_demo` defaults `true`: G6 only ever produces demo/mock authorizations.
 *     A live/sandbox authorization would carry additional legal-gate provenance
 *     that is out of G6's scope entirely.
 */
export const AorAuthorizationSchema = z.object({
  /** The org's OWN UEI. The gate refuses unless this matches the package's org. */
  org_uei: z.string(),
  /** Self-reported name of the human AOR. Used only for the attestation record. */
  aor_name: z.string(),
  /** MUST be literally `true` — an unchecked box is the absence of authorization. */
  attested: z.literal(true),
  /** ISO-8601 timestamp of when the human attested. */
  attested_at: z.string().datetime(),
  /** The single opportunity this attestation is scoped to (never blanket). */
  scope: z.object({ opportunity_id: z.string() }),
  /** True for the mock/demo path — the only path G6 produces. */
  is_demo: z.boolean().default(true),
});
export type AorAuthorization = z.infer<typeof AorAuthorizationSchema>;

// ---------------------------------------------------------------------------
// Submission status vocabulary (shared by receipt + status)
// ---------------------------------------------------------------------------

/**
 * The mock lifecycle vocabulary. In G6 these are produced ONLY by the mock
 * transport's in-memory record — they never reflect the state of a real federal
 * submission. `MOCK_COMPLETE` is the terminal happy-path state (spec §7).
 */
export const SUBMISSION_STATUS_VALUES = [
  "RECEIVED",
  "VALIDATED",
  "MOCK_COMPLETE",
  "REJECTED",
] as const;
export const SubmissionStatusValueSchema = z.enum(SUBMISSION_STATUS_VALUES);
export type SubmissionStatusValue = z.infer<typeof SubmissionStatusValueSchema>;

// ---------------------------------------------------------------------------
// Submission receipt — ALWAYS a mock (spec §8.2, HR-3)
// ---------------------------------------------------------------------------

/**
 * The receipt returned by a (mock) submission. G6 ONLY EVER produces mock
 * receipts, and the schema enforces that structurally:
 *   - `is_mock` is `z.literal(true)` and `submitted_to` is `z.literal("MOCK")`,
 *     so a receipt claiming a real system simply cannot parse (HR-3, §10.1).
 *   - `human_note` carries the unmissable, plain-language disclosure
 *     (e.g. "MOCK — nothing was submitted to any federal system.").
 * Nothing here ever asserts that a real submission occurred.
 */
export const SubmissionReceiptSchema = z.object({
  /** Mock tracking id (e.g. a `MOCK-XXXX` string) — never a real federal id. */
  tracking_id: z.string(),
  status: SubmissionStatusValueSchema,
  /** MUST be literally `true` — G6 produces no non-mock receipt. */
  is_mock: z.literal(true),
  /** MUST be literally `"MOCK"` — never a real system label. */
  submitted_to: z.literal("MOCK"),
  /** Human-readable "nothing was submitted to any federal system" disclosure. */
  human_note: z.string(),
  /** ISO-8601 timestamp of when the mock produced the receipt. */
  received_at: z.string().datetime(),
});
export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;

// ---------------------------------------------------------------------------
// Submission status object — mock-only convenience (spec §7)
// ---------------------------------------------------------------------------

/**
 * A mock-only status object. The (optional) transport status method returns this;
 * it NEVER polls a real endpoint. Like the receipt, `is_mock` is a
 * `z.literal(true)` so a status object cannot masquerade as a real one.
 */
export const SubmissionStatusSchema = z.object({
  tracking_id: z.string(),
  status: SubmissionStatusValueSchema,
  /** MUST be literally `true` — this is a mock status, never a real one. */
  is_mock: z.literal(true),
  /** ISO-8601 timestamp of when the status was checked (in-memory, mock). */
  checked_at: z.string().datetime(),
});
export type SubmissionStatus = z.infer<typeof SubmissionStatusSchema>;

// ---------------------------------------------------------------------------
// Legal-review gate (server-only; documented here, not read here)
// ---------------------------------------------------------------------------

/**
 * The server-only legal-review gate (spec §6.2, §10.2). Its value comes from a
 * NON-public env var (a plain `process.env.*`, never a `NEXT_PUBLIC_*` one — it
 * must never reach the client bundle). It is NOT read in this module; it is
 * defined here so the gate function (T-C) and the client can require
 * `legalReviewApproved === true` for any non-mock transport.
 *
 * In G6 no non-mock transport is ever wired, so this gate is only reachable via
 * tests with a fake transport — which is exactly how the HR-4 invariant is proven
 * (spec §6.2, §12/T4).
 */
export interface LegalGate {
  legalReviewApproved: boolean;
}

// ---------------------------------------------------------------------------
// Submission metadata — derived from the Opportunity, NEVER fabricated
// ---------------------------------------------------------------------------

/**
 * Submission metadata that is NOT carried on the shared `AssembledPackage` (which
 * folds narratives + forms + budget + gaps) and is instead derived from the
 * `Opportunity` record by the pure `toSubmissionMeta` (see `meta.ts`).
 *
 * The optional ids embody HR-1 (anti-fabrication): a value is present ONLY if the
 * `Opportunity` actually carries it. When absent it is left `undefined` — the
 * downstream XML mapper (T-B) renders each such gap as a VISIBLE marker, never an
 * invented number (spec §9.3: `cfda_number`/`competition_id` are not guaranteed
 * on the record, so when absent they become gaps, not fabrications).
 */
export const SubmissionMetaSchema = z.object({
  /** The opportunity's stable id (`Opportunity.id`). */
  opportunity_id: z.string(),
  /** Human title for the submission (title → program → id fallback). */
  program_title: z.string(),
  /** The record's source label (e.g. "grants.gov", "sbir"). */
  source_label: z.string(),
  /** Present only if the record carries a non-empty agency; else undefined. */
  agency: z.string().optional(),
  /** Present only if the record carries it; NEVER fabricated when absent. */
  cfda_number: z.string().optional(),
  /** Present only if the record carries it; NEVER fabricated when absent. */
  competition_id: z.string().optional(),
});
export type SubmissionMeta = z.infer<typeof SubmissionMetaSchema>;

// ---------------------------------------------------------------------------
// Convenience re-export of the shared package type (type-only)
// ---------------------------------------------------------------------------

/**
 * The single shared WS-G source of truth, imported READ-ONLY (spec §0.1). G6
 * CONSUMES `AssembledPackage`; it never defines, assembles, or re-derives a
 * package. Re-exported here (type-only, so it adds no runtime dependency) purely
 * for the convenience of G6 consumers importing from `lib/s2s`.
 */
export type { AssembledPackage } from "../apply/package";
