import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { explainMatchesTwoPass } from "../claude";
import { withHostedFetch } from "../llm/client";
import type { Opportunity, StartupProfile } from "../types";

/**
 * E3 — HOSTED two-pass must stay exactly as it was before the local-default
 * change: concurrent batches of up to 12 (Pass A) / 8 (Pass B), and Pass B
 * narrates EVERY candidate that clears PROMOTION_FLOOR (25) — no top-N cap.
 * Exercises the REAL `explainMatchesTwoPass` against a stubbed fetch standing
 * in for the Anthropic API (no network, no live model, no API key spend).
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
const savedTopN = process.env.E3_TWO_PASS_TOP_N;

afterEach(() => {
  for (const [key, saved] of [
    ["LLM_PROVIDER", savedProvider],
    ["ANTHROPIC_API_KEY", savedApiKey],
    ["E3_TWO_PASS_TOP_N", savedTopN],
  ] as const) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

// 10 candidates, all clearing PROMOTION_FLOOR (25) — more than the local top-N
// default (8), so an unwanted cap on hosted would show up as a shortfall.
const SCORES: Record<string, number> = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [`opp-${i}`, 90 - i]),
);
const candidates = Object.keys(SCORES).map(opp);

function idsInBody(body: string): string[] {
  return candidates.filter((c) => body.includes(`"${c.id}"`)).map((c) => c.id);
}

function fakeAnthropicFetch(calls: { passA: string[][]; passB: string[][] }): typeof fetch {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const userContent: string = body.messages.find((m: any) => m.role === "user")?.content ?? "";
    const ids = idsInBody(userContent);
    const isPassA = body.max_tokens <= 1024;
    let text: string;
    if (isPassA) {
      calls.passA.push(ids);
      text = JSON.stringify(ids.map((id) => ({ id, score: SCORES[id] })));
    } else {
      calls.passB.push(ids);
      text = JSON.stringify(
        ids.map((id) => ({
          id,
          score: SCORES[id],
          tier: "likely",
          criteria: [],
          whyCare: `care ${id}`,
          whyFit: `fit ${id}`,
          whyIneligible: "",
          whatToVerify: `check ${id}`,
          whatToDoNext: `next ${id}`,
        })),
      );
    }
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

test("hosted: Pass A/B stay batched (12/8), and Pass B narrates every promoted candidate uncapped", async () => {
  delete process.env.LLM_PROVIDER; // default → hosted (anthropic)
  process.env.ANTHROPIC_API_KEY = "sk-ant-testkey00000000";
  delete process.env.E3_TWO_PASS_TOP_N; // default: local caps at 8, hosted must NOT

  const calls = { passA: [] as string[][], passB: [] as string[][] };

  const result = await withHostedFetch(fakeAnthropicFetch(calls), () =>
    explainMatchesTwoPass(profile, candidates),
  );

  // Batched: 10 candidates fit in a single Pass-A call (batch size 12), not one call each.
  assert.equal(calls.passA.length, 1, "hosted Pass A stays batched, not one-candidate-per-call");
  assert.equal(calls.passA[0].length, 10);

  // Batched: 10 promoted candidates split into ceil(10/8) = 2 Pass-B calls, not 10.
  assert.equal(calls.passB.length, 2, "hosted Pass B stays batched (size 8), not one-candidate-per-call");
  assert.deepEqual(new Set(calls.passB.flat()), new Set(candidates.map((c) => c.id)), "every promoted candidate is narrated, uncapped");

  // Every candidate got its full narrative — no top-N cap silently degraded any of them to score-only.
  const byId = new Map(result.map((r) => [r.id, r]));
  for (const c of candidates) {
    assert.equal(byId.get(c.id)!.whyFit, `fit ${c.id}`, `${c.id} should be fully narrated on hosted, uncapped`);
  }
});
