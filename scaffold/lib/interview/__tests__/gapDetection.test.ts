import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectGaps,
  pruneAnsweredQuestions,
  generateQuestions,
  type InterviewQuestion,
  type InterviewChatClient,
} from "../generateQuestions";
import type { CompanyProfile } from "../../contracts/companyProfile";

/**
 * B1a — gap detection. The R1 interview is a GAP interview: ask only the
 * material fields the profile is still missing, never re-ask a provided one, and
 * a fully-filled profile asks ZERO questions. These tests pin all three.
 */

const cell = (value: unknown) => ({ value, provenance: "user_stated" as const, confidence: 1 });

/** A profile that provides every one of the 13 material fields. */
function filledProfile(): Partial<CompanyProfile> {
  return {
    id: "p1",
    raw_text: cell("We build autonomous drones for agriculture."),
    industry: cell("agtech"),
    technology: cell("autonomous drones"),
    location: cell("Reno, NV"),
    use_of_funds: cell("hire engineers and run field trials"),
    employee_count: cell(12),
    revenue: cell("1m_10m"),
    funding_stage: cell("seed"),
    capital_raised: cell("250k_1m"),
    rd_activities: cell("yes — active flight-controller R&D"),
    product_maturity: cell("mvp"),
    target_customers: cell("row-crop vineyards"),
    capital_requirement: cell("1m_5m"),
  } as Partial<CompanyProfile>;
}

const ALL_13 = [
  "raw_text",
  "industry",
  "technology",
  "location",
  "use_of_funds",
  "employee_count",
  "revenue",
  "funding_stage",
  "capital_raised",
  "rd_activities",
  "product_maturity",
  "target_customers",
  "capital_requirement",
];

function mkQ(
  id: string,
  maps_to: string | null,
  over: Partial<InterviewQuestion> = {},
): InterviewQuestion {
  return {
    id,
    question: `Question ${id}?`,
    routing_target: "program_family",
    gate_class: null,
    answer_kind: "single_select",
    options: [{ value: "a", label: "A" }],
    allow_free_text: true,
    rationale: "",
    maps_to_profile_field: maps_to,
    priority: 1,
    ...over,
  };
}

// --- detectGaps ------------------------------------------------------------

test("detectGaps: an empty profile is missing all 13 material fields, in ask-order", () => {
  const gaps = detectGaps({});
  assert.deepEqual(gaps.map((g) => g.field), ALL_13);
});

test("detectGaps: a fully-filled profile has ZERO gaps", () => {
  assert.deepEqual(detectGaps(filledProfile()), []);
});

test("detectGaps: a provided field is never a gap; every other material field is", () => {
  const partial: Partial<CompanyProfile> = {
    raw_text: cell("We build drones."),
    industry: cell("agtech"),
    location: cell("Reno, NV"),
  } as Partial<CompanyProfile>;
  const gapFields = detectGaps(partial).map((g) => g.field);
  // provided → not asked
  assert.ok(!gapFields.includes("raw_text"));
  assert.ok(!gapFields.includes("industry"));
  assert.ok(!gapFields.includes("location"));
  // everything else → asked
  assert.deepEqual(
    gapFields,
    ALL_13.filter((f) => !["raw_text", "industry", "location"].includes(f)),
  );
});

test("detectGaps: a blank/empty value counts as a gap (not silently 'provided')", () => {
  const partial = { industry: cell("   "), revenue: cell("") } as Partial<CompanyProfile>;
  const gapFields = detectGaps(partial).map((g) => g.field);
  assert.ok(gapFields.includes("industry"));
  assert.ok(gapFields.includes("revenue"));
});

test("detectGaps: gaps only ever cover required + material fields (no optional-tier field)", () => {
  const gapFields = detectGaps({}).map((g) => g.field);
  // entity_type / uei / sam_registered etc. are optional-tier — never gapped here.
  for (const optional of ["entity_type", "uei", "sam_registered", "trl", "naics_codes"]) {
    assert.ok(!gapFields.includes(optional));
  }
});

// --- pruneAnsweredQuestions -------------------------------------------------

test("pruneAnsweredQuestions: drops questions for provided fields, keeps missing + unmapped", () => {
  const profile = { industry: cell("agtech") } as Partial<CompanyProfile>;
  const qs = [
    mkQ("q1", "industry"), // provided → dropped
    mkQ("q2", "location"), // missing → kept
    mkQ("q3", null), // unmapped free question → kept
  ];
  const out = pruneAnsweredQuestions(qs, profile);
  assert.deepEqual(out.map((q) => q.id), ["q2", "q3"]);
});

// --- generateQuestions wiring ----------------------------------------------

/** A client that fails the test if the model is ever called. */
const throwingClient: InterviewChatClient = {
  messages: {
    create: async () => {
      throw new Error("model must not be called when there are no gaps");
    },
  },
};

/** A client returning a fixed set of questions. */
function cannedClient(questions: unknown[]): InterviewChatClient {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: JSON.stringify({ questions }) }] }),
    },
  };
}

test("generateQuestions: a fully-filled profile yields ZERO questions and never calls the model", async () => {
  const out = await generateQuestions("We build drones for agriculture.", {
    profile: filledProfile(),
    client: throwingClient,
  });
  assert.deepEqual(out, []);
});

test("generateQuestions: a fully-filled profile needs no API key (short-circuits before the client)", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const out = await generateQuestions("We build drones for agriculture.", {
      profile: filledProfile(),
    });
    assert.deepEqual(out, []);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test("generateQuestions: with a sparse profile, a re-ask of a provided field is pruned; the gap question survives", async () => {
  const profile = {
    raw_text: cell("We build drones."),
    industry: cell("agtech"), // already provided
  } as Partial<CompanyProfile>;

  const client = cannedClient([
    {
      question: "What industry are you in?",
      routing_target: "program_family",
      answer_kind: "single_select",
      options: [{ value: "agtech", label: "AgTech" }],
      maps_to_profile_field: "industry", // provided → must be pruned
    },
    {
      question: "Where are you primarily located?",
      routing_target: "program_family",
      answer_kind: "single_select",
      options: [{ value: "west", label: "West" }],
      maps_to_profile_field: "location", // missing → must survive
    },
  ]);

  const out = await generateQuestions("We build drones.", { profile, client });
  const mapped = out.map((q) => q.maps_to_profile_field);
  assert.ok(!mapped.includes("industry"), "provided field is not re-asked");
  assert.ok(mapped.includes("location"), "missing field is still asked");
});

test("generateQuestions: without a profile, behavior is unchanged (no pruning)", async () => {
  // The same canned re-ask of a field is NOT pruned when no profile is passed —
  // the description-only path is untouched by the gap feature.
  const client = cannedClient([
    {
      question: "What industry are you in?",
      routing_target: "program_family",
      answer_kind: "single_select",
      options: [{ value: "agtech", label: "AgTech" }],
      maps_to_profile_field: "industry",
    },
  ]);
  const out = await generateQuestions("We build drones.", { client });
  assert.equal(out.length, 1);
  assert.equal(out[0].maps_to_profile_field, "industry");
});
