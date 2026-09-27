import { test, after } from "node:test";
import assert from "node:assert/strict";
import { screen, type ScreeningRule, type ScreenableOpportunity } from "../screen";
import {
  EligibilityDeterminationSchema,
  type EligibilityDetermination,
} from "../../contracts/eligibilityDetermination";
import { EligibilityRuleCategorySchema } from "../../contracts/opportunity";
import type { EligibilityRuleCategory } from "../../contracts/opportunity";
import { ProvenanceSchema } from "../../contracts/primitives";
import type { Provenance, Citation } from "../../contracts/primitives";
import type { CompanyProfile } from "../../contracts/companyProfile";
import { getSql, getOpportunityById, closeStore } from "../../canon/store";
import { getEligibilityRules, type EligibilityRuleRow } from "../../canon/rules";

/**
 * ELG-03 — END-TO-END / INTEGRATION tests of the ELG-01 screening engine
 * (`lib/eligibility/screen.ts`) against the REAL Canon rules: the per-opportunity
 * `model_inferred` rows in Supabase (`eligibility_rules`) PLUS the code-level
 * universal overlay, evaluated over a bounded, READ-ONLY sample of real
 * opportunities.
 *
 * Proves the two non-negotiable invariants on REAL data (R8 / R8.4 / §11):
 *
 *   (1) ZERO FALSE EXCLUSIONS — no sampled real opportunity, against any test
 *       profile, ever lands in bucket `excluded`.
 *   (2) R8.4 HOLDS ACROSS THE REAL RULE SET — no per-opportunity `model_inferred`
 *       rule ever appears in `failed_rules` (and `failed_rules` stays empty:
 *       real DB rules are prose with NO structured predicate, so — mapped to
 *       predicate-less `ScreeningRule`s — they are advisory and can never gate).
 *
 * READ-ONLY: this suite only ever SELECTs (via `getOpportunityById` /
 * `getEligibilityRules`, plus a `select 1` probe). It NEVER writes. No LLM.
 *
 * GRACEFUL SKIP: if `FUNDFINDER_DB_PASSWORD` is unset, or the DB is unreachable
 * within a short timeout, the suite SKIPS (it never fails) so `npm test` stays
 * green in CI where the corpus DB is not reachable.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How many real opportunities to sample (bounded — READ-ONLY). */
const SAMPLE_SIZE = 40;
/** Connectivity-probe timeout: fail fast → skip, never hang CI. */
const PROBE_TIMEOUT_MS = 8000;
/** Per-opportunity data-pull concurrency (kept small for the transaction pooler). */
const PULL_CONCURRENCY = 5;

const SECRET_PRESENT =
  typeof process.env.FUNDFINDER_DB_PASSWORD === "string" &&
  process.env.FUNDFINDER_DB_PASSWORD.length > 0;

// Ensure the shared client is always closed, even on the skip paths.
after(async () => {
  await closeStore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Race a promise against a timer so a hung connection becomes a clean skip. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    // Don't let the timer keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Build a Citation from a DB rule row, only when at least one part is present. */
function citationFromRow(row: EligibilityRuleRow): Citation | undefined {
  const c: Citation = {};
  if (row.citation_url) c.source_url = row.citation_url;
  if (row.citation_name) c.source_name = row.citation_name;
  if (row.citation_quote) c.quote = row.citation_quote;
  if (row.citation_retrieved_at) c.retrieved_at = row.citation_retrieved_at;
  return Object.keys(c).length > 0 ? c : undefined;
}

/**
 * Map a real `eligibility_rules` row to the engine's `ScreeningRule`.
 *
 * `category` may be null in the DB → coerce to a valid `EligibilityRuleCategory`
 * (fall back to `"other"`). `provenance` is coerced to a valid `Provenance`
 * (anything unexpected — e.g. a materialized `authoritative` overlay row — falls
 * back to `model_inferred`, the SAFE choice: unreviewed → can never gate an
 * exclusion). `predicate` is intentionally left `undefined` — real rows carry
 * prose, not a machine-evaluable predicate, so the engine treats them as
 * advisory (this is exactly the production mapping ELG-01 documents).
 */
function toScreeningRule(row: EligibilityRuleRow): ScreeningRule {
  const category: EligibilityRuleCategory = EligibilityRuleCategorySchema.safeParse(
    row.category,
  ).success
    ? (row.category as EligibilityRuleCategory)
    : "other";
  const provenance: Provenance = ProvenanceSchema.safeParse(row.provenance).success
    ? (row.provenance as Provenance)
    : "model_inferred";
  const rule: ScreeningRule = {
    id: String(row.id),
    category,
    description: row.rule,
    provenance,
    _origin: "per_opp",
    // predicate intentionally undefined (advisory prose).
  };
  const citation = citationFromRow(row);
  if (citation) rule.citation = citation;
  return rule;
}

/** A provenanced profile field (mirrors the fixture helper in screen.test.ts). */
function pf<T>(value: T, provenance: Provenance = "user_stated", confidence = 1) {
  return { value, provenance, confidence };
}

/** Representative CompanyProfiles to screen every real opportunity against. */
const PROFILES: Array<{ name: string; profile: CompanyProfile }> = [
  {
    name: "minimal (only raw_text — nothing structured)",
    profile: {
      id: "elg03-minimal",
      raw_text: pf("We build software for small businesses.", "user_stated"),
      interview_answers: [],
    },
  },
  {
    name: "fuller eligible-shaped (US-owned small biz, SAM active)",
    profile: {
      id: "elg03-fuller-eligible",
      raw_text: pf("US-owned R&D startup.", "user_stated"),
      interview_answers: [],
      entity_type: pf("for_profit_small_business", "user_stated"),
      us_owned: pf(true, "user_stated"),
      employee_count: pf(12, "user_stated"),
      sam_registered: pf(true, "user_stated"),
    },
  },
  {
    name: "no SAM registration (exercises the conditional gate)",
    profile: {
      id: "elg03-no-sam",
      raw_text: pf("Pre-registration small business.", "user_stated"),
      interview_answers: [],
      entity_type: pf("for_profit_small_business", "user_stated"),
      us_owned: pf(true, "user_stated"),
      employee_count: pf(8, "user_stated"),
      sam_registered: pf(false, "user_stated"),
    },
  },
  {
    name: "apparent SBIR-violator (foreign-owned, large) — must NOT exclude",
    profile: {
      id: "elg03-sbir-violator",
      raw_text: pf("Large foreign-owned firm.", "user_stated"),
      interview_answers: [],
      entity_type: pf("for_profit_other", "user_stated"),
      us_owned: pf(false, "user_stated"),
      employee_count: pf(9000, "user_stated"),
      sam_registered: pf(true, "user_stated"),
    },
  },
];

/** Run `mapper` over `items` with a small fixed concurrency. */
async function mapPooled<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i]);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

// ---------------------------------------------------------------------------
// The integration suite
// ---------------------------------------------------------------------------

test(
  "ELG-03 integration: real Canon rules never produce a false exclusion or a failed model_inferred rule (R8.4 / §11)",
  { skip: SECRET_PRESENT ? false : "FUNDFINDER_DB_PASSWORD not set — live DB integration skipped" },
  async (t) => {
    // --- Connectivity probe (short timeout → skip, never hang / fail) --------
    try {
      const sql = getSql();
      await withTimeout(sql`select 1 as ok`, PROBE_TIMEOUT_MS, "DB connectivity probe");
    } catch (err) {
      t.diagnostic(
        `SKIP: Canon DB unreachable — ${errMessage(err)}. ` +
          `Integration assertions not run (this is a skip, not a failure).`,
      );
      t.skip("Canon DB unreachable");
      return;
    }

    const sql = getSql();

    // --- Pull a bounded, rule-preferring sample (READ-ONLY) ------------------
    // Prefer opportunities that actually HAVE eligibility_rules so the test
    // exercises the real per-opportunity rule set.
    let idRows = await withTimeout(
      sql<{ id: string }[]>`
        select id from opportunities
        where id in (select opportunity_id from eligibility_rules)
        order by id
        limit ${SAMPLE_SIZE}`,
      PROBE_TIMEOUT_MS,
      "sample query (rule-bearing)",
    );
    let sampledFrom: "rule_bearing" | "all_opportunities" = "rule_bearing";
    if (idRows.length === 0) {
      // No rule-bearing opportunities in this corpus snapshot — fall back to a
      // plain sample so the universal overlay is still exercised on real opps.
      sampledFrom = "all_opportunities";
      idRows = await withTimeout(
        sql<{ id: string }[]>`select id from opportunities order by id limit ${SAMPLE_SIZE}`,
        PROBE_TIMEOUT_MS,
        "sample query (all)",
      );
    }

    if (idRows.length === 0) {
      t.diagnostic("SKIP: corpus has zero opportunities — nothing to screen.");
      t.skip("empty corpus");
      return;
    }

    const ids = idRows.map((r) => r.id);

    // --- For each opportunity: fetch its contract shape + its real rules -----
    interface Pulled {
      id: string;
      opp: ScreenableOpportunity;
      rules: ScreeningRule[];
      ruleRows: EligibilityRuleRow[];
    }
    const pulled = await mapPooled<string, Pulled>(ids, PULL_CONCURRENCY, async (id) => {
      const [opp, ruleRows] = await Promise.all([
        getOpportunityById(id),
        getEligibilityRules(id),
      ]);
      const screenable: ScreenableOpportunity = opp
        ? { id: opp.id, program: opp.program, title: opp.title }
        : { id };
      return { id, opp: screenable, rules: ruleRows.map(toScreeningRule), ruleRows };
    });

    // --- Screen every (opportunity × profile) and assert the invariants ------
    const buckets: Record<EligibilityDetermination["bucket"], number> = {
      eligible: 0,
      conditionally_eligible: 0,
      excluded: 0,
      unknown: 0,
    };
    let determinations = 0;
    let oppsWithRules = 0;
    let totalRuleRows = 0;
    let modelInferredRuleRows = 0;
    const provenancesSeen = new Set<string>();
    const categoriesSeen = new Set<string>();

    for (const p of pulled) {
      if (p.ruleRows.length > 0) oppsWithRules++;
      totalRuleRows += p.ruleRows.length;
      for (const rr of p.ruleRows) {
        if (rr.model_inferred) modelInferredRuleRows++;
        provenancesSeen.add(String(rr.provenance));
        categoriesSeen.add(String(rr.category));
      }

      for (const { name, profile } of PROFILES) {
        const d = screen(profile, p.opp, p.rules);
        determinations++;
        buckets[d.bucket]++;

        const where = `opp=${p.id} profile="${name}"`;

        // Defense in depth: the determination round-trips through CON-01.
        assert.doesNotThrow(
          () => EligibilityDeterminationSchema.parse(d),
          `determination must be schema-valid (${where})`,
        );

        // INVARIANT (1): ZERO FALSE EXCLUSIONS on real data.
        assert.notEqual(
          d.bucket,
          "excluded",
          `FALSE EXCLUSION on real opportunity (${where}). ` +
            `failed_rules=${JSON.stringify(d.failed_rules)}`,
        );

        // INVARIANT (2): R8.4 across the real rule set — no rule ever failed
        // (real rows are predicate-less prose → advisory), and in particular
        // no model_inferred rule ever lands in failed_rules.
        assert.equal(
          d.failed_rules.length,
          0,
          `no real rule may land in failed_rules (${where}). ` +
            `failed_rules=${JSON.stringify(d.failed_rules)}`,
        );
        for (const fr of d.failed_rules) {
          assert.notEqual(
            fr.provenance,
            "model_inferred",
            `R8.4 VIOLATION: model_inferred rule in failed_rules (${where}, rule_id=${fr.rule_id})`,
          );
        }
      }
    }

    // --- Diagnostic summary (bucket distribution across the sample) ----------
    const dist =
      `eligible=${buckets.eligible} ` +
      `conditionally_eligible=${buckets.conditionally_eligible} ` +
      `unknown=${buckets.unknown} ` +
      `excluded=${buckets.excluded}`;
    t.diagnostic(`sampled_from=${sampledFrom}`);
    t.diagnostic(
      `sample: ${pulled.length} opportunities, ${oppsWithRules} with >=1 rule, ` +
        `${totalRuleRows} rule rows total (${modelInferredRuleRows} model_inferred).`,
    );
    t.diagnostic(
      `rule provenances seen: ${Array.from(provenancesSeen).sort().join(", ") || "(none)"}`,
    );
    t.diagnostic(
      `rule categories seen: ${Array.from(categoriesSeen).sort().join(", ") || "(none)"}`,
    );
    t.diagnostic(`determinations: ${determinations}`);
    t.diagnostic(`bucket distribution: ${dist}`);
    t.diagnostic(`ZERO false exclusions: ${buckets.excluded === 0 ? "CONFIRMED" : "VIOLATED"}`);

    // Final hard gates on the aggregate.
    assert.equal(buckets.excluded, 0, "AGGREGATE: zero real opportunities may be excluded.");
    assert.ok(determinations > 0, "expected at least one determination to be produced.");
  },
);
