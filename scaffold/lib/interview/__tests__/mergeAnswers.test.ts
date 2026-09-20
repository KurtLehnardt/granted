import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompanyProfileSchema,
  type CompanyProfile,
  type InterviewAnswer,
} from "../../contracts/companyProfile";
import type { Provenance } from "../../contracts/primitives";
import type { InterviewQuestion } from "../generateQuestions";
import { mergeAnswers } from "../mergeAnswers";

// --- Builders ---------------------------------------------------------------

function mkProfile(over: Partial<CompanyProfile> = {}): CompanyProfile {
  return CompanyProfileSchema.parse({
    id: "profile_1",
    raw_text: {
      value: "We build autonomous drones for agriculture.",
      provenance: "user_stated",
      confidence: 1,
    },
    interview_answers: [],
    ...over,
  });
}

function mkQ(
  id: string,
  maps_to: string | null,
  over: Partial<InterviewQuestion> = {},
): InterviewQuestion {
  return {
    id,
    question: `Question ${id}?`,
    routing_target: "eligibility_gate",
    gate_class: "entity_type",
    answer_kind: "single_select",
    options: [],
    allow_free_text: true,
    rationale: "",
    maps_to_profile_field: maps_to,
    priority: 1,
    ...over,
  };
}

function mkAnswer(
  question_id: string,
  value: string | string[],
  opts: {
    skipped?: boolean;
    provenance?: Provenance;
    confidence?: number;
    question?: string;
  } = {},
): InterviewAnswer {
  return {
    question_id,
    question: opts.question ?? `Question ${question_id}?`,
    answer: {
      value,
      provenance: opts.provenance ?? "user_stated",
      confidence: opts.confidence ?? 1,
    },
    skipped: opts.skipped ?? false,
  };
}

// --- 1. answered gate → mapped field set, provenance user_stated ------------

test("answered gate → mapped field set with user_stated provenance + carried confidence", () => {
  const base = mkProfile();
  const qs = [mkQ("q1", "entity_type")];
  const as = [mkAnswer("q1", "for_profit_small_business", { confidence: 0.9 })];
  const { profile } = mergeAnswers(base, qs, as);
  assert.deepEqual(profile.entity_type, {
    value: "for_profit_small_business",
    provenance: "user_stated",
    confidence: 0.9,
  });
});

test("provenance + confidence are carried from the answer onto the field", () => {
  const base = mkProfile();
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "industry")],
    [mkAnswer("q1", "biotech", { confidence: 0.42, provenance: "user_stated" })],
  );
  assert.equal(profile.industry?.value, "biotech");
  assert.equal(profile.industry?.confidence, 0.42);
  assert.equal(profile.industry?.provenance, "user_stated");
});

// --- 2. skipped answer → field unchanged ------------------------------------

test("skipped answer leaves its field unchanged and is not recorded", () => {
  const base = mkProfile();
  const qs = [mkQ("q1", "location")];
  const as = [mkAnswer("q1", "Boise, ID", { skipped: true })];
  const { profile } = mergeAnswers(base, qs, as);
  assert.equal(profile.location, undefined);
  assert.equal(profile.interview_answers.length, 0);
});

test("skipped answer does not fold into the enriched description", () => {
  const base = mkProfile({
    raw_text: { value: "Base text.", provenance: "user_stated", confidence: 1 },
  });
  const { enrichedDescription } = mergeAnswers(
    base,
    [mkQ("q1", "location")],
    [mkAnswer("q1", "Boise, ID", { skipped: true })],
  );
  assert.equal(enrichedDescription, "Base text.");
});

// --- 3. no matching answer for a question → field unchanged -----------------

test("a question with no answer leaves its field unchanged", () => {
  const base = mkProfile();
  const qs = [mkQ("q1", "industry"), mkQ("q2", "location")];
  const as = [mkAnswer("q1", "agriculture technology")];
  const { profile } = mergeAnswers(base, qs, as);
  assert.equal(profile.industry?.value, "agriculture technology");
  assert.equal(profile.location, undefined);
});

// --- 4. free-text `other` on string vs enum field ---------------------------

test("free-text on a string field is preserved verbatim", () => {
  const base = mkProfile();
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "location")],
    [mkAnswer("q1", "A small town near Fargo")],
  );
  assert.equal(profile.location?.value, "A small town near Fargo");
});

test("a genuine non-member free-text escape on an enum field leaves it unset but records the answer", () => {
  // "worker cooperative" is NOT a member of EntityTypeSchema → not forced in.
  const base = mkProfile();
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "entity_type")],
    [mkAnswer("q1", "worker cooperative")],
  );
  assert.equal(profile.entity_type, undefined);
  assert.equal(profile.interview_answers.length, 1);
  assert.equal(profile.interview_answers[0].question_id, "q1");
});

test("an escape value coinciding with a real enum member (entity_type 'other') is set, not fabricated", () => {
  // EntityTypeSchema DOES include "other" as a member, so selecting it is a
  // legitimate user-stated value — the merge validates against the real
  // contract rather than blindly rejecting the literal token "other".
  const base = mkProfile();
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "entity_type")],
    [mkAnswer("q1", "other")],
  );
  assert.deepEqual(profile.entity_type, {
    value: "other",
    provenance: "user_stated",
    confidence: 1,
  });
});

test("certifications enum-array keeps valid members and drops 'other'/non-members", () => {
  const base = mkProfile();
  assert.deepEqual(
    mergeAnswers(
      base,
      [mkQ("q1", "certifications")],
      [mkAnswer("q1", ["wosb", "other", "8a"])],
    ).profile.certifications?.value,
    ["wosb", "8a"],
  );
  assert.equal(
    mergeAnswers(
      base,
      [mkQ("q1", "certifications")],
      [mkAnswer("q1", ["other"])],
    ).profile.certifications,
    undefined,
  );
  assert.deepEqual(
    mergeAnswers(
      base,
      [mkQ("q1", "certifications")],
      [mkAnswer("q1", "hubzone")],
    ).profile.certifications?.value,
    ["hubzone"],
  );
});

// --- 5. no fabrication + description content --------------------------------

test("no answers → no structured fields added; description is the raw text verbatim", () => {
  const base = mkProfile({
    raw_text: { value: "We build X.", provenance: "user_stated", confidence: 1 },
  });
  const { profile, enrichedDescription } = mergeAnswers(base, [], []);
  assert.equal(profile.entity_type, undefined);
  assert.equal(profile.location, undefined);
  assert.equal(profile.employee_count, undefined);
  assert.equal(enrichedDescription, "We build X.");
});

test("enriched description = original text verbatim + each answered pair, nothing invented", () => {
  const base = mkProfile({
    raw_text: { value: "We build drones.", provenance: "user_stated", confidence: 1 },
  });
  const qs = [
    mkQ("q1", "location", { question: "Where are you based?" }),
    mkQ("q2", null, { question: "Tell us more?" }),
  ];
  const as = [
    mkAnswer("q1", "Reno, NV", { question: "Where are you based?" }),
    mkAnswer("q2", "We sell to vineyards", { question: "Tell us more?" }),
  ];
  const { enrichedDescription } = mergeAnswers(base, qs, as);
  assert.ok(enrichedDescription.startsWith("We build drones."));
  assert.ok(enrichedDescription.includes("Where are you based?"));
  assert.ok(enrichedDescription.includes("Reno, NV"));
  assert.ok(enrichedDescription.includes("We sell to vineyards"));
  // No invented facts: description mentions only supplied content.
  assert.ok(!/nonprofit|employee|TRL/i.test(enrichedDescription));
});

test("array answers render compactly in the description", () => {
  const base = mkProfile({
    raw_text: { value: "Base.", provenance: "user_stated", confidence: 1 },
  });
  const { enrichedDescription } = mergeAnswers(
    base,
    [mkQ("q1", "certifications", { question: "Which certifications?" })],
    [mkAnswer("q1", ["wosb", "8a"], { question: "Which certifications?" })],
  );
  assert.ok(enrichedDescription.includes("wosb, 8a"));
});

// --- 6. never-overwrite guard (both directions) -----------------------------

test("model_inferred answer does NOT overwrite an existing user_stated field", () => {
  const base = mkProfile({
    entity_type: {
      value: "for_profit_small_business",
      provenance: "user_stated",
      confidence: 1,
    },
  });
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "entity_type")],
    [mkAnswer("q1", "nonprofit", { provenance: "model_inferred", confidence: 0.5 })],
  );
  assert.deepEqual(profile.entity_type, {
    value: "for_profit_small_business",
    provenance: "user_stated",
    confidence: 1,
  });
});

test("model_inferred answer does NOT overwrite an existing verified field", () => {
  const base = mkProfile({
    us_owned: { value: true, provenance: "verified", confidence: 1 },
  });
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "us_owned")],
    [mkAnswer("q1", "no", { provenance: "model_inferred", confidence: 0.5 })],
  );
  assert.deepEqual(profile.us_owned, {
    value: true,
    provenance: "verified",
    confidence: 1,
  });
});

test("user_stated answer supersedes an existing model_inferred field", () => {
  const base = mkProfile({
    entity_type: {
      value: "for_profit_other",
      provenance: "model_inferred",
      confidence: 0.4,
    },
  });
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "entity_type")],
    [mkAnswer("q1", "for_profit_small_business", { provenance: "user_stated" })],
  );
  assert.deepEqual(profile.entity_type, {
    value: "for_profit_small_business",
    provenance: "user_stated",
    confidence: 1,
  });
});

test("model_inferred answer fills an empty field", () => {
  const base = mkProfile();
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "entity_type")],
    [mkAnswer("q1", "nonprofit", { provenance: "model_inferred", confidence: 0.6 })],
  );
  assert.deepEqual(profile.entity_type, {
    value: "nonprofit",
    provenance: "model_inferred",
    confidence: 0.6,
  });
});

test("model_inferred answer replaces an existing model_inferred field", () => {
  const base = mkProfile({
    entity_type: { value: "tribal", provenance: "model_inferred", confidence: 0.3 },
  });
  const { profile } = mergeAnswers(
    base,
    [mkQ("q1", "entity_type")],
    [mkAnswer("q1", "nonprofit", { provenance: "model_inferred", confidence: 0.6 })],
  );
  assert.deepEqual(profile.entity_type, {
    value: "nonprofit",
    provenance: "model_inferred",
    confidence: 0.6,
  });
});

// --- 7. maps_to null → recorded + folded, no field set ----------------------

test("maps_to null → answer recorded and folded, no structured field set", () => {
  const base = mkProfile();
  const qs = [mkQ("q1", null, { question: "Anything else?" })];
  const as = [mkAnswer("q1", "We have three patents", { question: "Anything else?" })];
  const { profile, enrichedDescription } = mergeAnswers(base, qs, as);
  assert.equal(profile.interview_answers.length, 1);
  assert.equal(profile.interview_answers[0].answer.value, "We have three patents");
  assert.ok(enrichedDescription.includes("We have three patents"));
});

// --- 8. unknown / protected target field name -------------------------------

test("unknown/nonexistent target field name is ignored safely (no throw)", () => {
  const base = mkProfile();
  const qs = [mkQ("q1", "totally_made_up_field")];
  const as = [mkAnswer("q1", "some value")];
  assert.doesNotThrow(() => mergeAnswers(base, qs, as));
  const { profile } = mergeAnswers(base, qs, as);
  assert.equal(profile.interview_answers.length, 1);
});

test("an answer targeting a protected field (raw_text / id) never overwrites it", () => {
  const base = mkProfile({
    raw_text: { value: "original text", provenance: "user_stated", confidence: 1 },
  });
  const qs = [mkQ("q1", "raw_text"), mkQ("q2", "id"), mkQ("q3", "interview_answers")];
  const as = [
    mkAnswer("q1", "hijacked text"),
    mkAnswer("q2", "hijacked_id"),
    mkAnswer("q3", "hijacked"),
  ];
  const { profile } = mergeAnswers(base, qs, as);
  assert.equal(profile.raw_text.value, "original text");
  assert.equal(profile.id, "profile_1");
  // answers still recorded despite the protected mapping
  assert.equal(profile.interview_answers.length, 3);
});

// --- 9. number / boolean coercion (valid vs invalid) ------------------------

test("number coercion: valid in-range integer sets the field", () => {
  const base = mkProfile();
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "employee_count")], [mkAnswer("q1", "15")]).profile
      .employee_count?.value,
    15,
  );
  // single-element array coerces too
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "employee_count")], [mkAnswer("q1", ["42"])]).profile
      .employee_count?.value,
    42,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "trl")], [mkAnswer("q1", "6")]).profile.trl?.value,
    6,
  );
});

test("number coercion: non-numeric / non-integer / out-of-range left unset", () => {
  const base = mkProfile();
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "employee_count")], [mkAnswer("q1", "a dozen")])
      .profile.employee_count,
    undefined,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "employee_count")], [mkAnswer("q1", "15.5")]).profile
      .employee_count,
    undefined,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "employee_count")], [mkAnswer("q1", "")]).profile
      .employee_count,
    undefined,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "trl")], [mkAnswer("q1", "0")]).profile.trl,
    undefined,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "trl")], [mkAnswer("q1", "10")]).profile.trl,
    undefined,
  );
});

test("boolean coercion: recognized yes/no tokens set the field; unknown left unset", () => {
  const base = mkProfile();
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "us_owned")], [mkAnswer("q1", "yes")]).profile
      .us_owned?.value,
    true,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "us_owned")], [mkAnswer("q1", "No")]).profile
      .us_owned?.value,
    false,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "sam_registered")], [mkAnswer("q1", "true")]).profile
      .sam_registered?.value,
    true,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "prior_federal_funding")], [mkAnswer("q1", "n")])
      .profile.prior_federal_funding?.value,
    false,
  );
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "prior_federal_funding")], [mkAnswer("q1", "maybe")])
      .profile.prior_federal_funding,
    undefined,
  );
});

// --- string / string-array coercion -----------------------------------------

test("string-array field: string becomes a 1-element array; array is trimmed/filtered", () => {
  const base = mkProfile();
  assert.deepEqual(
    mergeAnswers(base, [mkQ("q1", "naics_codes")], [mkAnswer("q1", "541511")]).profile
      .naics_codes?.value,
    ["541511"],
  );
  assert.deepEqual(
    mergeAnswers(
      base,
      [mkQ("q1", "geography_designations")],
      [mkAnswer("q1", ["hubzone", "  ", "rural"])],
    ).profile.geography_designations?.value,
    ["hubzone", "rural"],
  );
  // an empty/whitespace-only array leaves the field unset
  assert.equal(
    mergeAnswers(base, [mkQ("q1", "naics_codes")], [mkAnswer("q1", ["", "  "])]).profile
      .naics_codes,
    undefined,
  );
});

// --- non-skipped empty answer -----------------------------------------------

test("non-skipped empty answer is recorded but sets no field and is not folded in", () => {
  const base = mkProfile({
    raw_text: { value: "Base.", provenance: "user_stated", confidence: 1 },
  });
  const { profile, enrichedDescription } = mergeAnswers(
    base,
    [mkQ("q1", "location")],
    [mkAnswer("q1", "   ")],
  );
  assert.equal(profile.location, undefined);
  assert.equal(profile.interview_answers.length, 1);
  assert.equal(enrichedDescription, "Base.");
});

// --- interview_answers dedupe / upsert --------------------------------------

test("non-skipped answers recorded once, deduped by question_id (existing replaced)", () => {
  const base = mkProfile({ interview_answers: [mkAnswer("q1", "old answer")] });
  const qs = [mkQ("q1", "location"), mkQ("q2", "industry")];
  const as = [mkAnswer("q1", "new answer"), mkAnswer("q2", "robotics")];
  const { profile } = mergeAnswers(base, qs, as);
  assert.equal(profile.interview_answers.length, 2);
  const q1 = profile.interview_answers.find((a) => a.question_id === "q1");
  assert.equal(q1?.answer.value, "new answer");
});

// --- 10. round-trip through CompanyProfileSchema.parse ----------------------

test("output profile round-trips through CompanyProfileSchema.parse", () => {
  const base = mkProfile();
  const qs = [
    mkQ("q1", "entity_type"),
    mkQ("q2", "employee_count"),
    mkQ("q3", "certifications"),
    mkQ("q4", "us_owned"),
    mkQ("q5", "geography_designations"),
    mkQ("q6", "trl"),
    mkQ("q7", "industry"),
  ];
  const as = [
    mkAnswer("q1", "nonprofit"),
    mkAnswer("q2", "42"),
    mkAnswer("q3", ["wosb", "hubzone"]),
    mkAnswer("q4", "yes"),
    mkAnswer("q5", ["rural"]),
    mkAnswer("q6", "7"),
    mkAnswer("q7", "agtech"),
  ];
  const { profile } = mergeAnswers(base, qs, as);
  assert.doesNotThrow(() => CompanyProfileSchema.parse(profile));
});

// --- 11. idempotency + determinism ------------------------------------------

test("merging is idempotent: feeding the result back yields the same profile + description", () => {
  const base = mkProfile();
  const qs = [
    mkQ("q1", "entity_type"),
    mkQ("q2", "location"),
    mkQ("q3", "employee_count"),
  ];
  const as = [
    mkAnswer("q1", "nonprofit", { provenance: "model_inferred", confidence: 0.6 }),
    mkAnswer("q2", "Austin, TX"),
    mkAnswer("q3", "20"),
  ];
  const r1 = mergeAnswers(base, qs, as);
  const r2 = mergeAnswers(r1.profile, qs, as);
  assert.deepEqual(r2.profile, r1.profile);
  assert.equal(r2.enrichedDescription, r1.enrichedDescription);
});

test("calling merge twice with identical inputs is deterministic", () => {
  const base = mkProfile();
  const qs = [mkQ("q1", "location")];
  const as = [mkAnswer("q1", "Denver, CO")];
  assert.deepEqual(mergeAnswers(base, qs, as), mergeAnswers(base, qs, as));
});

// --- purity: no input mutation ----------------------------------------------

test("does not mutate the input profile", () => {
  const base = mkProfile();
  const snapshot = structuredClone(base);
  mergeAnswers(base, [mkQ("q1", "entity_type")], [mkAnswer("q1", "nonprofit")]);
  assert.deepEqual(base, snapshot);
});
