import type { Opportunity } from "../contracts/opportunity";
import { SubmissionMetaSchema, type SubmissionMeta } from "./types";

/**
 * WS-G / G6 — pure `Opportunity` → `SubmissionMeta` derivation.
 *
 * PURE and model-free: no network, no model call, no side effects, no clock —
 * identical inputs yield an identical result. This is the thin adapter for the
 * submission metadata that is NOT on the shared `AssembledPackage` (spec §0.1):
 * the opportunity id, a human title, the source label, and — ONLY when the record
 * actually carries them — the agency / CFDA / competition ids.
 *
 * HONESTY (HR-1, spec §9.3): this function NEVER invents an identifier. A field
 * is filled only from a value the `Opportunity` genuinely carries; anything the
 * record lacks is left `undefined` so the downstream XML mapper (T-B) renders it
 * as a visible `[you to provide: …]` / `<!-- GAP: … -->` marker rather than a
 * plausible-but-fabricated number.
 *
 * Note on the record shape (documented so no one "fixes" it by guessing): the
 * `Opportunity` contract (`lib/contracts/opportunity.ts`) carries `id`, `source`,
 * `kind`, `program`, `agency`, and an optional `title`, but it does NOT carry
 * `cfda_number` or `competition_id`. Those are therefore ALWAYS `undefined` here
 * (structural gaps), exactly as §9.3 requires — never read from an untyped bag,
 * never guessed.
 */
export function toSubmissionMeta(opportunity: Opportunity): SubmissionMeta {
  // program_title: title → program → id (mirrors `packageProgramTitle` in
  // `lib/apply/package.ts`, so G6's title never disagrees with G5's).
  const program_title =
    (opportunity.title ?? "").trim() ||
    (opportunity.program ?? "").trim() ||
    opportunity.id;

  // agency is required on the record, but treat a blank string as absence — an
  // empty agency is a gap, not a value to assert.
  const agencyTrimmed = (opportunity.agency ?? "").trim();

  const meta = {
    opportunity_id: opportunity.id,
    program_title,
    // The record's own source enum is the honest, non-fabricated source label.
    source_label: opportunity.source,
    agency: agencyTrimmed.length > 0 ? agencyTrimmed : undefined,
    // `cfda_number` / `competition_id` are not fields on the `Opportunity`
    // contract, so they are always undefined here — a gap, never invented (§9.3).
    cfda_number: undefined,
    competition_id: undefined,
  };

  // `.parse` as defense-in-depth (mirrors the G1/G2 contracts): validate the
  // derived shape before it flows downstream.
  return SubmissionMetaSchema.parse(meta);
}
