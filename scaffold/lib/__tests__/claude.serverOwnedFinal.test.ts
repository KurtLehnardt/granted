import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { explainMatches, explainMatchesTwoPass } from "../claude";
import { withHostedFetch } from "../llm/client";
import type { Opportunity, StartupProfile } from "../types";

/**
 * `final`/`unscored` are server-owned signals — the model's raw JSON output
 * must never be trusted for them. A model that returns `final: false` or
 * `unscored: true` on an otherwise real, scored assessment must not have
 * either field survive into the parsed Assessment.
 */

const QUERY_VEC = [1, 0];

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `grant ${id}`,
    eligibility: "US small business.",
    embedding: QUERY_VEC,
  };
}

const profile: StartupProfile = { description: "AI sensing hardware for federal customers.", employees: 20 };

const savedProvider = process.env.LLM_PROVIDER;
const savedApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  for (const [key, saved] of [
    ["LLM_PROVIDER", savedProvider],
    ["ANTHROPIC_API_KEY", savedApiKey],
  ] as const) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

function assessmentPayload(id: string) {
  return {
    id,
    score: 77,
    tier: "likely",
    criteria: [],
    whyCare: "care",
    whyFit: "fit",
    whyIneligible: "",
    whatToVerify: "verify",
    whatToDoNext: "next",
    final: false,
    unscored: true,
  };
}

function fakeFetch(text: string): typeof fetch {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const payload = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("explainMatches: a model-supplied final:false/unscored:true is stripped — the real score still shows", async () => {
  delete process.env.LLM_PROVIDER;
  process.env.ANTHROPIC_API_KEY = "sk-ant-testkey00000000";

  const candidate = opp("a");
  const text = JSON.stringify([assessmentPayload("a")]);
  const result = await withHostedFetch(fakeFetch(text), () => explainMatches(profile, [candidate]));

  assert.equal(result.length, 1);
  assert.equal(result[0].score, 77, "the real score is preserved");
  assert.equal(result[0].final, undefined, "a model-supplied final is stripped, not trusted");
  assert.equal(result[0].unscored, undefined, "a model-supplied unscored is stripped, not trusted");
});

test("explainMatchesTwoPass Pass B: a model-supplied final:false/unscored:true is stripped", async () => {
  delete process.env.LLM_PROVIDER;
  process.env.ANTHROPIC_API_KEY = "sk-ant-testkey00000000";

  const candidate = opp("b");
  const fetchImpl: typeof fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const isPassA = body.max_tokens <= 1024;
    const text = isPassA
      ? JSON.stringify([{ id: "b", score: 90 }])
      : JSON.stringify([assessmentPayload("b")]);
    const payload = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const result = await withHostedFetch(fetchImpl, () => explainMatchesTwoPass(profile, [candidate]));
  const b = result.find((r) => r.id === "b");
  assert.ok(b);
  assert.equal(b!.score, 77, "the real Pass-B score is preserved");
  assert.equal(b!.final, true, "assembleTwoPass's own terminal final:true wins, not the model's false");
  assert.equal(b!.unscored, undefined, "a model-supplied unscored is stripped from the narrated assessment");
});
