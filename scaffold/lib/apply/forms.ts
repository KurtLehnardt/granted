import {
  isFieldProvided,
  CAPITAL_REQUIREMENT_RANGES,
  type CompanyProfile,
  type EntityType,
} from "../contracts/companyProfile";
import type { AutoFillRequirements } from "../mockAuth";
import type { Opportunity } from "../contracts/opportunity";
import {
  PrefilledFormsSchema,
  type PrefilledField,
  type PrefilledForms,
} from "../contracts/applicationForms";

/**
 * WS-G / G3 — deterministic SF-424 federal form pre-fill.
 *
 * `prefillApplicationForms(profile, autoFillReqs, opp)` maps the founder's
 * `CompanyProfile` + the mock SAM/UEI settings (`AutoFillRequirements`) + the
 * matched `Opportunity` into a schema-validated `PrefilledForms` object for the
 * SF-424 family.
 *
 * THIS IS A PURE, MODEL-FREE MAPPER. There is NO model call — stronger
 * grounding, zero spend, hermetic tests. Because nothing is generated, there is
 * nothing to hallucinate: every field is either
 *   (a) GROUNDED — a real value derived from a named source (`source`), or
 *   (b) A GAP — the exact `[founder to provide: <hint>]` placeholder, emitted
 *       whenever a field is NOT derivable from the profile/SAM/opportunity data.
 * A plausible-but-invented org name, address, project title, amount, or date is
 * NEVER emitted. The honesty contract is enforced structurally by
 * `PrefilledFieldSchema` and re-validated here via `PrefilledFormsSchema.parse`
 * (defense-in-depth — the analogue of G1's `ApplicationRequirementsSchema.parse`
 * and G2's `ApplicationDraftSchema.parse`).
 *
 * The caller passes `autoFillReqs` IN. This function never reads localStorage
 * (`getAutoFillRequirements` does that in the React layer) so it stays pure and
 * testable with static fixtures.
 */

// ---------------------------------------------------------------------------
// Placeholder + field helpers — the `[founder to provide: …]` machinery.
// Built from the SAME literal shape as G2's `FOUNDER_TODO_PATTERN` so the one
// convention holds across every WS-G surface.
// ---------------------------------------------------------------------------

/** Wrap a plain hint into the exact `[founder to provide: <hint>]` placeholder shape. */
function toPlaceholder(hint: string): string {
  const clean = hint.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  return `[founder to provide: ${clean.length > 0 ? clean : "this detail"}]`;
}

/** Read a provenanced cell's raw value (`profile.<key>.value`), or undefined. */
function cellValue<T = unknown>(profile: CompanyProfile, key: string): T | undefined {
  const cell = (profile as Record<string, unknown>)[key] as { value?: T } | undefined;
  return cell?.value;
}

/** A GROUNDED field: real value + the source that names where it came from. */
function grounded(key: string, label: string, value: string, source: string): PrefilledField {
  return { key, label, status: "prefilled", value, display: value, source };
}

/** A GAP: a fillable blank. No value, no source — an honest `[founder to provide: …]`. */
function gap(key: string, label: string, hint: string): PrefilledField {
  return { key, label, status: "founder_to_provide", display: toPlaceholder(hint) };
}

// ---------------------------------------------------------------------------
// Small deterministic value maps (no inference — plain relabeling).
// ---------------------------------------------------------------------------

/** Human labels for the `entity_type` enum (SF-424 "Type of Applicant"). */
const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  for_profit_small_business: "For-profit — small business",
  for_profit_other: "For-profit — other than small business",
  nonprofit: "Nonprofit organization",
  higher_education: "Institution of higher education",
  state_or_local_government: "State or local government",
  tribal: "Tribal organization",
  individual: "Individual",
  other: "Other",
};

/** Human label for a coarse `capital_requirement` bucket (e.g. "250k_1m" → "$250K–$1M"). */
function capitalRangeLabel(bucket: string): string {
  return CAPITAL_REQUIREMENT_RANGES.find((r) => r.value === bucket)?.label ?? bucket;
}

// ---------------------------------------------------------------------------
// Per-field derivations. Each returns a single PrefilledField — GROUNDED when a
// value is derivable from the profile/SAM/opportunity data, a GAP otherwise.
// ---------------------------------------------------------------------------

/** UEI — the mock SAM settings are authoritative; the profile self-report is the fallback. */
function ueiField(profile: CompanyProfile, reqs: AutoFillRequirements): PrefilledField {
  const label = "Unique Entity Identifier (UEI)";
  const fromSam = reqs.uei.trim();
  if (fromSam.length > 0) return grounded("uei", label, fromSam, "sam.uei");
  if (isFieldProvided(profile, "uei")) {
    return grounded("uei", label, String(cellValue(profile, "uei")).trim(), "profile.uei");
  }
  return gap("uei", label, "UEI (Unique Entity Identifier)");
}

/**
 * SAM.gov registration status — always derivable. A positive self-report from
 * EITHER source wins; the default (nothing on file) grounds to "Not registered"
 * from the SAM settings. Never a gap: the founder's SAM settings always carry a
 * concrete boolean.
 */
function samStatusField(profile: CompanyProfile, reqs: AutoFillRequirements): PrefilledField {
  const key = "sam_registration_status";
  const label = "SAM.gov registration status";
  if (reqs.samRegistered) {
    const date = reqs.samRegisteredDate.trim();
    const display = date.length > 0 ? `Registered in SAM.gov (as of ${date})` : "Registered in SAM.gov";
    return grounded(key, label, display, "sam.samRegistered");
  }
  if (isFieldProvided(profile, "sam_registered")) {
    const registered = Boolean(cellValue(profile, "sam_registered"));
    const display = registered ? "Registered in SAM.gov" : "Not registered in SAM.gov";
    return grounded(key, label, display, "profile.sam_registered");
  }
  return grounded(key, label, "Not registered in SAM.gov", "sam.samRegistered");
}

/** Applicant / entity type — grounded from the profile's `entity_type` when set. */
function entityTypeField(profile: CompanyProfile): PrefilledField {
  const label = "Applicant / entity type";
  if (isFieldProvided(profile, "entity_type")) {
    const raw = String(cellValue(profile, "entity_type"));
    const display = ENTITY_TYPE_LABELS[raw as EntityType] ?? raw;
    return grounded("entity_type", label, display, "profile.entity_type");
  }
  return gap("entity_type", label, "applicant / entity type");
}

/** NAICS code(s) — grounded from the profile only; the opportunity carries none. */
function naicsField(profile: CompanyProfile): PrefilledField {
  const label = "NAICS code(s)";
  if (isFieldProvided(profile, "naics_codes")) {
    const codes = (cellValue<string[]>(profile, "naics_codes") ?? []).map((c) => c.trim()).filter(Boolean);
    if (codes.length > 0) return grounded("naics_code", label, codes.join(", "), "profile.naics_codes");
  }
  return gap("naics_code", label, "NAICS code(s)");
}

/** Authorized representative (AOR) name — grounded from the mock SAM settings when named. */
function aorField(reqs: AutoFillRequirements): PrefilledField {
  const label = "Authorized representative (AOR) name";
  const name = reqs.aorName.trim();
  if (name.length > 0) return grounded("authorized_representative_name", label, name, "sam.aorName");
  // `aorOnFile` may be true with no name typed — we still can't fill a name we
  // don't have, so it stays an honest gap rather than a fabricated name.
  return gap("authorized_representative_name", label, "authorized representative name");
}

/** Awarding agency — grounded from the opportunity record. */
function agencyField(opp: Opportunity): PrefilledField {
  const label = "Awarding agency";
  const agency = (opp.agency ?? "").trim();
  if (agency.length > 0) return grounded("awarding_agency", label, agency, "opportunity.agency");
  return gap("awarding_agency", label, "awarding agency");
}

/** Funding opportunity title — grounded from the opportunity's `title` or `program`. */
function opportunityTitleField(opp: Opportunity): PrefilledField {
  const label = "Funding opportunity title";
  const title = (opp.title ?? "").trim();
  if (title.length > 0) return grounded("funding_opportunity_title", label, title, "opportunity.title");
  const program = (opp.program ?? "").trim();
  if (program.length > 0) return grounded("funding_opportunity_title", label, program, "opportunity.program");
  return gap("funding_opportunity_title", label, "funding opportunity title");
}

/** Funding opportunity number — grounded from the source-system id when present. */
function opportunityNumberField(opp: Opportunity): PrefilledField {
  const label = "Funding opportunity number";
  const number = (opp.source_id ?? "").trim();
  if (number.length > 0) return grounded("funding_opportunity_number", label, number, "opportunity.source_id");
  return gap("funding_opportunity_number", label, "funding opportunity number");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The program title carried onto the package (opportunity title/program, else id). */
function programTitle(opp: Opportunity): string {
  return (opp.title ?? "").trim() || (opp.program ?? "").trim() || opp.id;
}

/**
 * Deterministically pre-fill the SF-424 core federal-application fields from a
 * founder's `CompanyProfile`, the mock SAM/UEI settings, and the matched
 * `Opportunity`. Pure and model-free. Every returned field is grounded (with a
 * `source`) or an honest `[founder to provide: …]` gap. The output is validated
 * through `PrefilledFormsSchema.parse` before it is returned.
 */
export function prefillApplicationForms(
  profile: CompanyProfile,
  autoFillReqs: AutoFillRequirements,
  opp: Opportunity,
): PrefilledForms {
  const applicantLocation: PrefilledField = isFieldProvided(profile, "location")
    ? grounded(
        "applicant_location",
        "Applicant location (as stated)",
        String(cellValue(profile, "location")).trim(),
        "profile.location",
      )
    : gap("applicant_location", "Applicant location (as stated)", "applicant location");

  const fields: PrefilledField[] = [
    // --- Program / agency identifiers (grounded from the Opportunity record) ---
    opportunityNumberField(opp),
    opportunityTitleField(opp),
    agencyField(opp),

    // --- Applicant-specific narrative fields (not derivable → honest gaps) ---
    // The project title is the APPLICANT's title, not the program title.
    gap("project_title", "Project title", "project title"),
    // No profile field carries a legal org name.
    gap("organization_name", "Organization legal name", "organization legal name"),

    // --- Registration facts (grounded from SAM settings / profile) ---
    ueiField(profile, autoFillReqs),
    samStatusField(profile, autoFillReqs),
    entityTypeField(profile),

    // --- Address. `profile.location` is COARSE (e.g. "Boise, Idaho"): expose it
    //     as a grounded note, but the structured SF-424 street/city/state/zip
    //     sub-fields are NOT reliably derivable from it — never fabricate them. ---
    applicantLocation,
    gap("applicant_street", "Street address", "street address"),
    gap("applicant_city", "City", "city"),
    gap("applicant_state", "State", "state"),
    gap("applicant_zip", "ZIP / postal code", "ZIP / postal code"),
    gap("applicant_congressional_district", "Applicant congressional district", "applicant congressional district"),

    naicsField(profile),
    aorField(autoFillReqs),

    // --- Amounts. `capital_requirement` is a coarse RANGE bucket, not the exact
    //     SF-424 figure: the exact amounts are gaps. The founder's stated range
    //     is attached below (when present) as a NON-authoritative hint. ---
    gap("federal_funding_requested", "Federal funding requested (exact dollar figure)", "federal funding amount requested (exact dollar figure)"),
    gap("total_project_cost", "Total project cost (exact dollar figure)", "total project cost (exact dollar figure)"),

    // --- Project dates. Opportunity key_dates are PROGRAM dates, not the
    //     applicant's project dates — never repurpose them. ---
    gap("project_start_date", "Proposed project start date", "proposed project start date"),
    gap("project_end_date", "Proposed project end date", "proposed project end date"),
  ];

  // Non-authoritative grounded hint: the founder's stated capital RANGE. Clearly
  // labeled as a coarse range, NOT the exact SF-424 amount above. Included only
  // when actually provided (never manufactured into a gap — the exact-amount
  // gaps above already carry the honest blank).
  if (isFieldProvided(profile, "capital_requirement")) {
    const bucket = String(cellValue(profile, "capital_requirement"));
    fields.push(
      grounded(
        "capital_requirement_range",
        "Founder's stated capital range (coarse — NOT the SF-424 exact amount)",
        capitalRangeLabel(bucket),
        "profile.capital_requirement",
      ),
    );
  }

  const gaps = fields.filter((f) => f.status === "founder_to_provide").map((f) => f.display);

  const pkg: PrefilledForms = {
    opportunity_id: opp.id,
    program_title: programTitle(opp),
    generated_at: new Date().toISOString(),
    forms: [{ form_name: "SF-424", fields }],
    gaps,
  };

  // Defense-in-depth: re-validate the honesty contract through the schema
  // (grounded ⇒ value+source, gap ⇒ placeholder-only, gaps complete & well-formed).
  return PrefilledFormsSchema.parse(pkg);
}
