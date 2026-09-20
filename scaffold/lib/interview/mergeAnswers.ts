import { z } from "zod";

import {
  CompanyProfileSchema,
  CertificationSchema,
  type CompanyProfile,
  type InterviewAnswer,
} from "../contracts/companyProfile";
import type { Provenance } from "../contracts/primitives";
import type { InterviewQuestion } from "./generateQuestions";

/**
 * INT-02 — R1 answer → enriched-description MERGE (counterpart to INT-01).
 *
 * Pure, synchronous, hermetic. NO LLM, NO network. Given the user's base
 * `CompanyProfile` (their original `raw_text`), the `InterviewQuestion[]` that
 * INT-01 generated, and the `InterviewAnswer[]` the user gave, this produces:
 *
 *   (a) an ENRICHED `CompanyProfile` — structured fields populated at the
 *       correct provenance (§11: a user answer is `user_stated`; a
 *       skipped-then-inferred answer is `model_inferred`), and
 *   (b) an ENRICHED description string — the original text verbatim followed by
 *       a compact, factual rendering of each answered Q/A pair — that feeds the
 *       expensive search.
 *
 * Provenance is the whole point (§11). This module NEVER fabricates a fact the
 * user did not give, and NEVER lets a `model_inferred` value clobber an
 * existing `user_stated`/`verified` fact.
 *
 * Answers are joined to questions by `answer.question_id === question.id`; the
 * target `CompanyProfile` field is read from that question's
 * `maps_to_profile_field`. `InterviewAnswer` itself carries no field mapping.
 */

// --- Public options / result ------------------------------------------------

export interface MergeAnswersOptions {
  /**
   * Heading placed before the rendered Q/A pairs in the enriched description.
   * Deterministic; defaults to `"Interview answers:"`.
   */
  interviewHeading?: string;
}

export interface MergeAnswersResult {
  /** The enriched profile. Round-trips `CompanyProfileSchema.parse`. */
  profile: CompanyProfile;
  /** Deterministic enriched description: original text + answered Q/A pairs. */
  enrichedDescription: string;
}

const DEFAULT_INTERVIEW_HEADING = "Interview answers:";

// --- Field coercion registry ------------------------------------------------

/**
 * How a user answer (`string | string[]`) is coerced into a given
 * `CompanyProfile` structured field. This lists ONLY the enrichable structured
 * fields; `id`, `raw_text`, and `interview_answers` are deliberately absent, so
 * an answer can never target them. A `maps_to_profile_field` that is not a key
 * here is treated as unknown and ignored safely (answer still recorded + folded
 * into the description).
 */
type FieldKind =
  | "string"
  | "string_array"
  | "enum"
  | "enum_array"
  | "number"
  | "boolean";

const FIELD_KINDS: Record<string, FieldKind> = {
  entity_type: "enum",
  us_owned: "boolean",
  employee_count: "number",
  location: "string",
  geography_designations: "string_array",
  certifications: "enum_array",
  sam_registered: "boolean",
  uei: "string",
  industry: "string",
  technology: "string",
  trl: "number",
  naics_codes: "string_array",
  funding_stage: "string",
  revenue: "string",
  capital_raised: "string",
  capital_requirement: "string",
  use_of_funds: "string",
  rd_activities: "string",
  product_maturity: "string",
  target_customers: "string",
  prior_federal_funding: "boolean",
  expanded_terms: "string_array",
};

/** Recognized affirmative / negative tokens for boolean fields. */
const TRUE_TOKENS = new Set(["yes", "y", "true", "t"]);
const FALSE_TOKENS = new Set(["no", "n", "false", "f"]);

/**
 * The real per-field provenanced schemas, read straight off the CON-01
 * contract. Used as the single validator so a value can only be written if it
 * actually satisfies `CompanyProfileSchema` (int/range on numbers, enum
 * membership, etc.). No contract shape is restated here.
 */
const PROFILE_SHAPE = CompanyProfileSchema.shape as Record<string, z.ZodTypeAny>;

// --- Coercion ---------------------------------------------------------------

type Coerced = { ok: true; value: unknown } | { ok: false };
const FAIL: Coerced = { ok: false };

/** Reduce an answer value to a single string, or null when that's impossible. */
function toSingle(v: string | string[]): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length === 1) return v[0] ?? null;
  return null;
}

/** Reduce an answer value to a trimmed, non-empty string array. */
function toArray(v: string | string[]): string[] {
  const items = typeof v === "string" ? [v] : v;
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Coerce a raw answer value into the JS shape a field expects — conservatively
 * and without inventing facts. Anything not coercible returns `{ ok: false }`
 * and the field is left unset. Final validity (int/range, enum membership) is
 * still checked against the contract schema by the caller.
 */
function coerce(kind: FieldKind, v: string | string[]): Coerced {
  switch (kind) {
    case "string": {
      if (typeof v === "string") {
        const t = v.trim();
        return t.length > 0 ? { ok: true, value: t } : FAIL;
      }
      const arr = toArray(v);
      return arr.length > 0 ? { ok: true, value: arr.join(", ") } : FAIL;
    }
    case "string_array": {
      const arr = toArray(v);
      return arr.length > 0 ? { ok: true, value: arr } : FAIL;
    }
    case "enum": {
      const s = toSingle(v);
      if (s === null) return FAIL;
      const t = s.trim();
      // Membership (incl. rejecting `other`/free-text) is enforced downstream
      // by the field schema; we only forward a candidate string here.
      return t.length > 0 ? { ok: true, value: t } : FAIL;
    }
    case "enum_array": {
      // Keep only real enum members; drop `other`/free-text without inventing.
      const arr = toArray(v).filter(
        (el) => CertificationSchema.safeParse(el).success,
      );
      return arr.length > 0 ? { ok: true, value: arr } : FAIL;
    }
    case "number": {
      const s = toSingle(v);
      if (s === null) return FAIL;
      const t = s.trim();
      if (t.length === 0) return FAIL; // guard: Number("") === 0
      const n = Number(t);
      if (!Number.isFinite(n)) return FAIL;
      // int + in-range is validated downstream by the field schema.
      return { ok: true, value: n };
    }
    case "boolean": {
      const s = toSingle(v);
      if (s === null) return FAIL;
      const t = s.trim().toLowerCase();
      if (TRUE_TOKENS.has(t)) return { ok: true, value: true };
      if (FALSE_TOKENS.has(t)) return { ok: true, value: false };
      return FAIL;
    }
  }
}

// --- Never-overwrite guard (§11) --------------------------------------------

/**
 * Whether an incoming answer of `incoming` provenance may write over a field
 * that currently holds `existing` provenance.
 *
 * - empty field                     → any provenance may fill it.
 * - incoming `user_stated`/`verified` → may supersede anything.
 * - incoming `model_inferred`        → may replace only another `model_inferred`;
 *                                       NEVER a `user_stated`/`verified` fact.
 */
function canWrite(
  existing: Provenance | undefined,
  incoming: Provenance,
): boolean {
  if (existing === undefined) return true;
  if (incoming === "user_stated" || incoming === "verified") return true;
  return existing === "model_inferred";
}

// --- Enriched description ----------------------------------------------------

/** Compact, factual rendering of an answer value. No invented facts. */
function renderAnswerValue(v: string | string[]): string {
  if (Array.isArray(v)) {
    return v
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(", ");
  }
  return v.trim();
}

function hasContent(v: string | string[]): boolean {
  return renderAnswerValue(v).length > 0;
}

// --- Entry point ------------------------------------------------------------

/**
 * Merge the user's interview answers into their base profile.
 *
 * Pure & deterministic: no LLM, no network, no input mutation. The base profile
 * must carry at least `id` + `raw_text`; every other structured field is
 * optional and only set when an answer supports it without fabrication.
 */
export function mergeAnswers(
  baseProfile: CompanyProfile,
  questions: InterviewQuestion[],
  answers: InterviewAnswer[],
  options: MergeAnswersOptions = {},
): MergeAnswersResult {
  // Deep clone so the caller's profile is never mutated.
  const working = structuredClone(baseProfile) as Record<string, unknown>;

  const recorded = Array.isArray(working.interview_answers)
    ? (working.interview_answers as InterviewAnswer[])
    : [];

  const questionById = new Map<string, InterviewQuestion>();
  for (const q of questions) questionById.set(q.id, q);

  for (const ans of answers) {
    // Skipped answers are not real answers: they change no field, are not
    // recorded, and are not folded into the description.
    if (ans.skipped) continue;

    // 1) Record every non-skipped answer once, deduped by question_id.
    const existingIdx = recorded.findIndex(
      (r) => r.question_id === ans.question_id,
    );
    const entry = structuredClone(ans);
    if (existingIdx >= 0) recorded[existingIdx] = entry;
    else recorded.push(entry);

    // 2) Set the mapped structured field, if any, conservatively.
    const question = questionById.get(ans.question_id);
    const field = question?.maps_to_profile_field ?? null;
    if (field === null) continue; // recorded + folded only
    if (!Object.prototype.hasOwnProperty.call(FIELD_KINDS, field)) continue; // unknown/protected → ignore safely

    const coerced = coerce(FIELD_KINDS[field], ans.answer.value);
    if (!coerced.ok) continue; // uncoercible → recorded + folded, field unset

    const current = working[field] as
      | { provenance: Provenance }
      | undefined;
    if (!canWrite(current?.provenance, ans.answer.provenance)) continue;

    const candidate = {
      value: coerced.value,
      provenance: ans.answer.provenance,
      confidence: ans.answer.confidence,
    };
    // Validate the full provenanced value against the real contract schema;
    // only assign if it actually satisfies CompanyProfile (int/range, enum
    // membership, etc.). This is what makes the output round-trip.
    const res = PROFILE_SHAPE[field].safeParse(candidate);
    if (res.success) working[field] = res.data;
  }

  working.interview_answers = recorded;

  // Guarantee the output round-trips (and normalize defaults).
  const profile = CompanyProfileSchema.parse(working);

  const enrichedDescription = buildEnrichedDescription(
    baseProfile,
    questionById,
    answers,
    options.interviewHeading ?? DEFAULT_INTERVIEW_HEADING,
  );

  return { profile, enrichedDescription };
}

/**
 * Deterministic enriched description: the user's original `raw_text.value`
 * verbatim at the front, then one compact factual line per answered Q/A pair.
 * Introduces no facts beyond the original text and the user's answers.
 */
function buildEnrichedDescription(
  baseProfile: CompanyProfile,
  questionById: Map<string, InterviewQuestion>,
  answers: InterviewAnswer[],
  heading: string,
): string {
  const rawText = baseProfile.raw_text?.value ?? "";

  const lines: string[] = [];
  for (const ans of answers) {
    if (ans.skipped) continue;
    if (!hasContent(ans.answer.value)) continue;
    const qText =
      (ans.question && ans.question.trim().length > 0
        ? ans.question
        : questionById.get(ans.question_id)?.question) ?? "";
    const rendered = renderAnswerValue(ans.answer.value);
    lines.push(qText.trim().length > 0 ? `- ${qText.trim()}: ${rendered}` : `- ${rendered}`);
  }

  if (lines.length === 0) return rawText;
  return [rawText, "", heading, ...lines].join("\n");
}
