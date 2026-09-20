import { z } from "zod";
import type postgres from "postgres";
import { getSql } from "./store";
import { CitationSchema } from "../contracts/primitives";
import type { Citation } from "../contracts/primitives";
import { EligibilityRuleCategorySchema } from "../contracts/opportunity";
import type { EligibilityRuleCategory } from "../contracts/opportunity";
import { RuleEvaluationSchema } from "../contracts/eligibilityDetermination";
import type { RuleEvaluation } from "../contracts/eligibilityDetermination";

/**
 * rules.ts — CAN-04 structured eligibility-rule extraction, WITH CITATIONS.
 *
 * Typed to the CON-01 `EligibilityDetermination` inputs (`RuleEvaluation`) so a
 * rule extracted here drops straight into ELG-01's `satisfied_rules` /
 * `failed_rules` / `unknown_rules`. Writes the `eligibility_rules` table
 * (CAN-01, migration 00001).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HARD CONTRACT (§8.3 / §11 / R8.4) — READ BEFORE CHANGING ANYTHING HERE:
 *
 *  1. NEVER fabricate a rule. Every rule this module stores carries a citation
 *     with (a) a `source_url` and (b) an exact `quote` that literally appears in
 *     the opportunity's own source text (or an authoritative page). A rule that
 *     cannot be traced to a citable source is DROPPED or represented as an
 *     `UnknownGate` — it is never stored as fact. `filterStorableRules()` is the
 *     code-level enforcement: it re-checks that each quote is grounded in the
 *     supplied source text and rejects the rest. Prompt instructions alone are
 *     not trusted.
 *
 *  2. Everything CAN-04 writes is `provenance = 'model_inferred'`
 *     (`model_inferred = true`). Per R8.4, a `model_inferred` rule MUST NOT gate
 *     an exclusion in ELG-01 until a human review promotes it to `verified`.
 *     "A user told they are ineligible on the strength of a hallucinated rule
 *     is the worst single failure this product can produce." The
 *     `EligibilityDetermination` schema already refuses an `excluded` bucket that
 *     rests only on `model_inferred` rules — this module produces exactly those
 *     rules, so ELG-01 treats them as advisory (they may make an opportunity
 *     `conditionally_eligible` or annotate a match, never `excluded`) until
 *     review. See ELG-01 contract note at the bottom of this file.
 *
 *  3. Unknown gates are representable as UNKNOWN, not guessed in either
 *     direction (R8.2). An eligibility class the source does not settle becomes
 *     an `UnknownGate` (round-trips as unknown; see `RuleExtractionSchema`). It
 *     is deliberately NOT written to `eligibility_rules` — a row in that table
 *     reads as an assertion, and "unknown" is the absence of an assertion. ELG-01
 *     reads the extraction result's `unknown_gates` and renders them as unknown.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The only provenance CAN-04 ever writes. Model extraction is `model_inferred`
 * until a human review promotes a rule to `verified` (R8.4).
 */
export const CAN04_PROVENANCE = "model_inferred" as const;

/**
 * Contract note surfaced to ELG-01 (do not delete — it is the machine-readable
 * form of R8.4 for the screening engine).
 */
export const ELG01_CONTRACT = {
  /** A `model_inferred` rule may never be the reason an opportunity is excluded. */
  model_inferred_rules_must_not_gate_exclusion: true,
  /** Gates with no cited rule are UNKNOWN — never guessed eligible or ineligible. */
  unknown_gates_render_as_unknown: true,
} as const;

// ---------------------------------------------------------------------------
// Types — the extraction result (the round-trip unit)
// ---------------------------------------------------------------------------

/**
 * A citation strict enough to STORE a rule on: unlike the base `CitationSchema`
 * (all fields optional), CAN-04 requires a fetchable `source_url` AND the exact
 * `quote` the rule rests on. No url + quote → the rule is not storable.
 */
export const CitedCitationSchema = CitationSchema.extend({
  source_url: z.string().url(),
  quote: z.string().min(1),
});
export type CitedCitation = z.infer<typeof CitedCitationSchema>;

/**
 * A single extracted, cited eligibility rule. Maps 1:1 to a CON-01
 * `RuleEvaluation` (via `toRuleEvaluation`) once it has a DB `rule_id`.
 */
export const ExtractedRuleSchema = z.object({
  category: EligibilityRuleCategorySchema,
  /** Human-readable statement of the gate (goes to `eligibility_rules.rule`). */
  description: z.string().min(1),
  /** MUST carry url + quote (R8.4). Rules without this are rejected. */
  citation: CitedCitationSchema,
  provenance: z.literal("model_inferred").default("model_inferred"),
  confidence: z.number().min(0).max(1).optional(),
});
export type ExtractedRule = z.infer<typeof ExtractedRuleSchema>;

/**
 * An eligibility class the source text does not determine. Represents "unknown"
 * explicitly so it can round-trip as unknown rather than being dropped silently
 * or guessed (R8.2). Not persisted to `eligibility_rules`.
 */
export const UnknownGateSchema = z.object({
  category: EligibilityRuleCategorySchema,
  status: z.literal("unknown").default("unknown"),
  /** Why it is undeterminable (e.g. "eligibility only links to an external page"). */
  reason: z.string().min(1),
});
export type UnknownGate = z.infer<typeof UnknownGateSchema>;

/**
 * The per-opportunity extraction result — the unit that round-trips. Carries the
 * cited rules AND the explicitly-unknown gates, plus provenance metadata for
 * reproducibility (R10.2: model + snapshot).
 */
export const RuleExtractionSchema = z.object({
  opportunity_id: z.string(),
  source_url: z.string().url().optional(),
  source_name: z.string().optional(),
  /** Model id that produced this (recorded for R10.2 reproducibility). */
  model: z.string(),
  /** ISO-8601 extraction timestamp. */
  extracted_at: z.string().datetime(),
  /** Canon snapshot the opportunity text came from (R10.2). */
  snapshot_version: z.string().optional(),
  rules: z.array(ExtractedRuleSchema).default([]),
  unknown_gates: z.array(UnknownGateSchema).default([]),
});
export type RuleExtraction = z.infer<typeof RuleExtractionSchema>;

/** Parse/validate an unknown value as a `RuleExtraction` (throws on failure). */
export function parseRuleExtraction(value: unknown): RuleExtraction {
  return RuleExtractionSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Anti-hallucination guard — a rule's quote MUST be in the source text (§11)
// ---------------------------------------------------------------------------

/**
 * Normalize to a lower-cased, alphanumeric WORD sequence: every run of
 * non-alphanumeric characters (punctuation, whitespace) collapses to one space.
 * Grounding then depends only on the exact words, in order — which is what
 * "the model read this from the source" means. This tolerates a model
 * reformatting punctuation/whitespace (e.g. adding a space after ";") while
 * still catching a paraphrase or an invented sentence, whose WORDS are not a
 * contiguous run of the source. It never weakens the guarantee: a rule whose
 * words are not literally present, in order, in the source is still rejected.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True iff `quote`'s word sequence appears verbatim (in order) within
 * `sourceText`. This is the hard gate behind R8.4: a rule whose quote is not in
 * the opportunity's own text was not read from it, so it is not storable.
 */
export function isQuoteGrounded(quote: string, sourceText: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length === 0) return false;
  return normalizeForMatch(sourceText).includes(q);
}

/** A rule dropped by `filterStorableRules`, with why (for the escalation report). */
export interface RejectedRule {
  rule: unknown;
  reason: "schema" | "quote_not_grounded";
  detail: string;
}

/**
 * Split model-proposed rules into what is safe to STORE and what must be
 * dropped. A rule is storable only if it (1) passes `ExtractedRuleSchema`
 * (has url + non-empty quote) AND (2) that quote is grounded in `sourceText`.
 * Everything else is rejected and reported — never stored (§11, R8.4).
 */
export function filterStorableRules(
  candidates: unknown[],
  sourceText: string,
): { storable: ExtractedRule[]; rejected: RejectedRule[] } {
  const storable: ExtractedRule[] = [];
  const rejected: RejectedRule[] = [];
  for (const c of candidates) {
    const parsed = ExtractedRuleSchema.safeParse(c);
    if (!parsed.success) {
      rejected.push({
        rule: c,
        reason: "schema",
        detail: parsed.error.issues.map((i) => i.message).join("; "),
      });
      continue;
    }
    const rule = parsed.data;
    if (!isQuoteGrounded(rule.citation.quote, sourceText)) {
      rejected.push({
        rule: c,
        reason: "quote_not_grounded",
        detail: `quote not found in source text: ${JSON.stringify(
          rule.citation.quote.slice(0, 120),
        )}`,
      });
      continue;
    }
    storable.push(rule);
  }
  return { storable, rejected };
}

// ---------------------------------------------------------------------------
// Mappers to CON-01 `EligibilityDetermination` inputs
// ---------------------------------------------------------------------------

/** Map a stored/extracted rule to a CON-01 `RuleEvaluation` (needs a rule_id). */
export function toRuleEvaluation(
  rule: ExtractedRule,
  rule_id: string,
): RuleEvaluation {
  const citation: Citation = rule.citation;
  return RuleEvaluationSchema.parse({
    rule_id,
    category: rule.category,
    description: rule.description,
    provenance: rule.provenance,
    citation,
  });
}

/**
 * Map an unknown gate to a CON-01 `RuleEvaluation` destined for
 * `EligibilityDetermination.unknown_rules[]` — never `failed_rules[]`.
 */
export function unknownGateToRuleEvaluation(
  gate: UnknownGate,
  rule_id: string,
): RuleEvaluation {
  return RuleEvaluationSchema.parse({
    rule_id,
    category: gate.category,
    description: gate.reason,
    provenance: "model_inferred",
  });
}

// ---------------------------------------------------------------------------
// Store I/O — the `eligibility_rules` table (CAN-01 migration 00001)
// ---------------------------------------------------------------------------

/** A row of `eligibility_rules` as returned by the store. */
export interface EligibilityRuleRow {
  id: string; // bigint identity → string
  opportunity_id: string;
  category: EligibilityRuleCategory | null;
  rule: string;
  citation_url: string | null;
  citation_name: string | null;
  citation_quote: string | null;
  citation_retrieved_at: string | null;
  provenance: string;
  model_inferred: boolean;
  created_at: string;
}

/**
 * Insert cited rules for one opportunity. Every rule is written
 * `provenance = 'model_inferred'`, `model_inferred = true` (R8.4). Throws rather
 * than storing a rule that lacks a valid citation — defense in depth on top of
 * `filterStorableRules`. Set `replace: true` to make re-runs idempotent (delete
 * this opportunity's prior CAN-04 rows first). Returns the number inserted.
 */
export async function insertEligibilityRules(
  opportunityId: string,
  rules: ExtractedRule[],
  opts: { sql?: postgres.Sql; replace?: boolean } = {},
): Promise<number> {
  const sql = opts.sql ?? getSql();

  // Boundary check: refuse to write anything uncited (never store a guess).
  for (const r of rules) {
    const parsed = ExtractedRuleSchema.safeParse(r);
    if (!parsed.success) {
      throw new Error(
        `Refusing to store an uncited/invalid rule for ${opportunityId}: ` +
          parsed.error.issues.map((i) => i.message).join("; "),
      );
    }
  }

  if (opts.replace) {
    // Scope the replace to model_inferred rows ONLY, so re-running extraction
    // never clobbers the curated authoritative overlay rows (model_inferred =
    // false) that `universalRules.ts` materializes onto the same opportunity.
    await sql`
      delete from eligibility_rules
      where opportunity_id = ${opportunityId} and model_inferred = true`;
  }

  let n = 0;
  for (const r of rules) {
    await sql`
      insert into eligibility_rules
        (opportunity_id, category, rule,
         citation_url, citation_name, citation_quote, citation_retrieved_at,
         provenance, model_inferred)
      values
        (${opportunityId}, ${r.category}, ${r.description},
         ${r.citation.source_url}, ${r.citation.source_name ?? null},
         ${r.citation.quote}, ${r.citation.retrieved_at ?? null},
         'model_inferred', true)
    `;
    n++;
  }
  return n;
}

/** Delete all `eligibility_rules` rows for an opportunity (idempotent re-run). */
export async function deleteEligibilityRules(
  opportunityId: string,
  opts: { sql?: postgres.Sql } = {},
): Promise<number> {
  const sql = opts.sql ?? getSql();
  const rows = await sql<{ id: string }[]>`
    delete from eligibility_rules where opportunity_id = ${opportunityId}
    returning id`;
  return rows.length;
}

/** Read back the stored rules for an opportunity. */
export async function getEligibilityRules(
  opportunityId: string,
  opts: { sql?: postgres.Sql } = {},
): Promise<EligibilityRuleRow[]> {
  const sql = opts.sql ?? getSql();
  const rows = await sql<EligibilityRuleRow[]>`
    select id::text, opportunity_id, category, rule,
           citation_url, citation_name, citation_quote,
           citation_retrieved_at::text, provenance, model_inferred,
           created_at::text
    from eligibility_rules
    where opportunity_id = ${opportunityId}
    order by id`;
  return rows;
}

/** Count `eligibility_rules` rows, optionally for one opportunity. */
export async function countEligibilityRules(
  opts: { opportunityId?: string; sql?: postgres.Sql } = {},
): Promise<number> {
  const sql = opts.sql ?? getSql();
  const rows = opts.opportunityId
    ? await sql<{ n: number }[]>`
        select count(*)::int n from eligibility_rules
        where opportunity_id = ${opts.opportunityId}`
    : await sql<{ n: number }[]>`select count(*)::int n from eligibility_rules`;
  return rows[0]?.n ?? 0;
}
