import { test } from "node:test";
import assert from "node:assert/strict";

import { OpportunitySchema, EligibilityRuleSchema } from "../opportunity";
import { EligibilityDeterminationSchema } from "../eligibilityDetermination";
import {
  ModelRoutingTableSchema,
  DEFAULT_MODEL_ROUTING,
} from "../modelRouting";
import { CitationSchema } from "../primitives";

const NOW_ISO = new Date().toISOString();

const eligibilityRule = {
  id: "rule_entity_type",
  category: "entity_type",
  description: "Limited to for-profit small businesses.",
  citation: { source_name: "SBIR PA", source_url: "https://www.sbir.gov/x", retrieved_at: NOW_ISO },
  provenance: "verified",
};

const opportunity = {
  // v1 base
  id: "opp_1",
  source: "grants.gov",
  kind: "grant",
  program: "Example Program",
  agency: "HHS",
  description: "An example NOFO.",
  fundingLow: 100000,
  fundingHigh: 500000,
  // §3.4 canon additions
  source_id: "HHS-2025-0001",
  title: "Example Program",
  status: "open",
  key_dates: { close_date: NOW_ISO },
  award_range: { floor: 100000, ceiling: 500000, currency: "USD" },
  eligibility_rules: [eligibilityRule],
  retrieved_at: NOW_ISO,
  corpus_version: "canon-2026-08-01",
};

test("§3.4 Opportunity (canon superset) parses", () => {
  assert.doesNotThrow(() => OpportunitySchema.parse(opportunity));
});

test("§3.4 EligibilityRule requires a citation and provenance", () => {
  assert.doesNotThrow(() => EligibilityRuleSchema.parse(eligibilityRule));
  const noProv = { ...eligibilityRule } as Record<string, unknown>;
  delete noProv.provenance;
  assert.equal(EligibilityRuleSchema.safeParse(noProv).success, false);
});

test("§3.5 EligibilityDetermination parses; rule evals carry provenance", () => {
  const det = {
    opportunity_id: "opp_1",
    bucket: "conditionally_eligible",
    satisfied_rules: [],
    failed_rules: [],
    unknown_rules: [
      {
        rule_id: "rule_entity_type",
        category: "entity_type",
        description: "Entity type unknown",
        provenance: "model_inferred",
      },
    ],
    required_steps: [
      { step: "Register in SAM.gov", lead_time_days: 21, why: "Required before submission" },
    ],
  };
  assert.doesNotThrow(() => EligibilityDeterminationSchema.parse(det));
});

test("§3.5 an `excluded` bucket with empty failed_rules is rejected (R8.2)", () => {
  const det = {
    opportunity_id: "opp_1",
    bucket: "excluded",
    failed_rules: [],
  };
  assert.equal(EligibilityDeterminationSchema.safeParse(det).success, false);
});

test("§3.5 an exclusion driven only by model_inferred rules is rejected (R8.4)", () => {
  const det = {
    opportunity_id: "opp_1",
    bucket: "excluded",
    failed_rules: [
      {
        rule_id: "rule_entity_type",
        category: "entity_type",
        description: "Guessed the entity is a nonprofit",
        provenance: "model_inferred",
      },
    ],
  };
  assert.equal(EligibilityDeterminationSchema.safeParse(det).success, false);
});

test("§3.5 an exclusion with a verified/user_stated failed rule is valid", () => {
  const det = {
    opportunity_id: "opp_1",
    bucket: "excluded",
    failed_rules: [
      {
        rule_id: "rule_entity_type",
        category: "entity_type",
        description: "Limited to institutions of higher education",
        provenance: "verified",
        citation: { source_name: "NOFO", source_url: "https://grants.gov/x" },
      },
      {
        rule_id: "rule_size",
        category: "size_ownership",
        description: "Model-guessed size gate",
        provenance: "model_inferred",
      },
    ],
  };
  assert.equal(EligibilityDeterminationSchema.safeParse(det).success, true);
});

test("§3.9 default model routing table validates", () => {
  assert.doesNotThrow(() => ModelRoutingTableSchema.parse(DEFAULT_MODEL_ROUTING));
});

test("§3.4 Opportunity.url accepts https:// and rejects a javascript: scheme (M8)", () => {
  assert.equal(
    OpportunitySchema.safeParse({ ...opportunity, url: "https://www.grants.gov/search-results-detail/123" })
      .success,
    true,
  );
  assert.equal(
    OpportunitySchema.safeParse({ ...opportunity, url: "javascript:alert(1)" }).success,
    false,
  );
});

test("CitationSchema.source_url accepts https:// and rejects a javascript: scheme (M8)", () => {
  assert.equal(
    CitationSchema.safeParse({ source_url: "https://www.sbir.gov/x" }).success,
    true,
  );
  assert.equal(
    CitationSchema.safeParse({ source_url: "javascript:alert(1)" }).success,
    false,
  );
});
