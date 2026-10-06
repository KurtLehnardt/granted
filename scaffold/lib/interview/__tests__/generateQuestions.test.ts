import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateQuestions,
  normalize,
  gateRankOf,
  InterviewGenerationError,
  type RawQuestion,
  type InterviewChatClient,
} from "../generateQuestions";

/**
 * INT-01 generateQuestions — hermetic unit tests (H7). Exercises the gate-first
 * ordering (R8.1) and structured-answer escape-hatch invariants over hand-built
 * RawQuestion fixtures (no network), the error paths that never touch the model,
 * and — via the injectable client seam — a reproduction of the EVL-03
 * `defense-hw-08` re-ask, which locks in the invariants normalize() CAN enforce
 * and makes the (prompt-level) re-ask gap test-visible.
 */

function rq(p: Partial<RawQuestion> & Pick<RawQuestion, "routing_target">): RawQuestion {
  return {
    question: p.question ?? "placeholder question?",
    routing_target: p.routing_target,
    answer_kind: p.answer_kind ?? "single_select",
    options: p.options ?? [{ value: "a", label: "A" }],
    gate_class: p.gate_class,
    allow_free_text: p.allow_free_text,
    rationale: p.rationale,
    maps_to_profile_field: p.maps_to_profile_field,
  };
}

// --- Gate-first ordering (R8.1) --------------------------------------------

test("normalize: gate-first — eligibility gates sort ahead of routing, by R8.1 gate rank, ids renumbered", () => {
  const raw: RawQuestion[] = [
    rq({ routing_target: "agency", question: "Which agency?" }),
    rq({ routing_target: "eligibility_gate", gate_class: "registration", question: "SAM registered?" }),
    rq({ routing_target: "eligibility_gate", gate_class: "entity_type", question: "Entity type?" }),
  ];
  const out = normalize(raw, 5);

  assert.equal(out[0].gate_class, "entity_type"); // gate rank 0
  assert.equal(out[1].gate_class, "registration"); // gate rank 3
  assert.equal(out[2].routing_target, "agency"); // non-gate, last
  assert.deepEqual(out.map((q) => q.id), ["q1", "q2", "q3"]);
  assert.deepEqual(out.map((q) => q.priority), [1, 2, 3]);
});

test("gateRankOf: classed gate < unspecified gate (90) < non-gate (100)", () => {
  assert.equal(gateRankOf(rq({ routing_target: "eligibility_gate", gate_class: "entity_type" })), 0);
  assert.equal(gateRankOf(rq({ routing_target: "eligibility_gate", gate_class: null })), 90);
  assert.equal(gateRankOf(rq({ routing_target: "agency" })), 100);
});

test("normalize: truncation happens AFTER sorting — a high-index gate survives over low-index agency questions", () => {
  const raw: RawQuestion[] = [
    rq({ routing_target: "agency", question: "a0" }),
    rq({ routing_target: "agency", question: "a1" }),
    rq({ routing_target: "agency", question: "a2" }),
    rq({ routing_target: "agency", question: "a3" }),
    rq({ routing_target: "agency", question: "a4" }),
    rq({ routing_target: "agency", question: "a5" }),
    rq({ routing_target: "eligibility_gate", gate_class: "program_prerequisite", question: "gate last" }),
  ];
  const out = normalize(raw, 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].routing_target, "eligibility_gate", "the gate must not be dropped for lower-index agency questions");
});

// --- Structured-answer escape-hatch invariant ------------------------------

test("normalizeAnswerShape (via normalize): a select with no options degrades to free_text", () => {
  const out = normalize([rq({ routing_target: "program_family", answer_kind: "single_select", options: [] })], 5);
  assert.equal(out[0].answer_kind, "free_text");
  assert.equal(out[0].options.length, 0);
  assert.equal(out[0].allow_free_text, true);
});

test("normalizeAnswerShape (via normalize): a select missing 'other' gets one appended, allow_free_text forced true", () => {
  const out = normalize(
    [rq({ routing_target: "program_family", answer_kind: "single_select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], allow_free_text: false })],
    5,
  );
  assert.equal(out[0].options.length, 3);
  assert.ok(out[0].options.some((o) => o.value === "other" || /other/i.test(o.label)));
  assert.equal(out[0].allow_free_text, true);
});

test("normalizeAnswerShape (via normalize): a select already containing an 'other' label is not double-appended", () => {
  const out = normalize(
    [rq({ routing_target: "program_family", answer_kind: "multi_select", options: [{ value: "a", label: "A" }, { value: "x", label: "Other / not sure" }] })],
    5,
  );
  assert.equal(out[0].options.length, 2);
});

// --- Error paths (no network) ----------------------------------------------

test("generateQuestions: empty / whitespace description rejects with InterviewGenerationError", async () => {
  await assert.rejects(generateQuestions(""), (e) => e instanceof InterviewGenerationError && /empty/i.test((e as Error).message));
  await assert.rejects(generateQuestions("   "), (e) => e instanceof InterviewGenerationError && /empty/i.test((e as Error).message));
});

test("generateQuestions: no provider configured (and no injected client) rejects, and needs no OpenAI key in particular", async () => {
  const saved = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_PROVIDER;
  try {
    await assert.rejects(
      generateQuestions("A valid company description with enough words to pass the length gate."),
      (e) => e instanceof InterviewGenerationError && /No model is configured/.test((e as Error).message),
    );
  } finally {
    for (const [k, v] of [["OPENAI_API_KEY", saved.openai], ["ANTHROPIC_API_KEY", saved.anthropic], ["LLM_PROVIDER", saved.provider]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("generateQuestions: goes through the lib/llm message shape and tolerates fenced JSON", async () => {
  let seen: any;
  const client: InterviewChatClient = {
    messages: {
      create: async (params: any) => {
        seen = params;
        return { content: [{ type: "text", text: "```json\n" + JSON.stringify({ questions: [{ question: "Q?", routing_target: "agency", answer_kind: "free_text" }] }) + "\n```" }] };
      },
    },
  };
  const out = await generateQuestions("We build drones for agriculture and need SBIR funding.", { client });
  assert.equal(out.length, 1);
  assert.equal(typeof seen.system, "string", "the prompt goes in `system`, Anthropic-style");
  assert.equal(seen.messages[0].role, "user");
});

// --- EVL-03 defense-hw-08 re-ask regression (injected client) --------------

test("EVL-03 regression (defense-hw-08): a canned re-ask of the ownership gate is ordered gate-first and keeps its structured escape; the redundant re-ask is NOT dropped by normalize (documents the gap is prompt-level)", async () => {
  // The exact shape of the buggy model output: it re-asks the >50% US-ownership
  // gate even though the description already answers it (70% foreign / 30% US).
  const cannedResponse = {
    questions: [
      {
        question: "Is your company more than 50% owned and controlled by US citizens or permanent residents?",
        routing_target: "eligibility_gate",
        gate_class: "ownership",
        answer_kind: "single_select",
        options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        maps_to_profile_field: "us_ownership",
      },
      {
        question: "Which agency's programs are you primarily targeting?",
        routing_target: "agency",
        answer_kind: "single_select",
        options: [{ value: "dod", label: "Department of Defense" }],
      },
    ],
  };
  const client: InterviewChatClient = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: JSON.stringify(cannedResponse) }] }),
    },
  };

  const out = await generateQuestions(
    "We build autonomous drone hardware. The company is 70% owned by a foreign parent corporation; the remaining 30% is held by US-citizen employees.",
    { client },
  );

  // Invariants normalize() DOES enforce, and must keep enforcing:
  assert.equal(out[0].routing_target, "eligibility_gate", "the gate is ordered first (gate-first, R8.1)");
  assert.equal(out[0].gate_class, "ownership");
  assert.equal(out[0].answer_kind, "single_select");
  assert.ok(out[0].options.some((o) => o.value === "other" || /other/i.test(o.label)), "structured escape hatch present");
  assert.equal(out[0].allow_free_text, true);

  // The known gap: normalize() has no description context, so it CANNOT drop
  // the ownership re-ask the description already answered. This asserts the
  // current behavior on purpose — if a future prompt/code change suppresses
  // the redundant re-ask, THIS assertion flips and forces a deliberate,
  // reviewed update rather than a silent one.
  assert.ok(
    out.some((q) => q.gate_class === "ownership"),
    "prompt-level gap: the redundant ownership re-ask survives normalization",
  );
});
