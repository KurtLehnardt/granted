import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps } from "../match";
import { explainMatches } from "../claude";
import { screen as realScreen } from "../eligibility/screen";
import type { Opportunity, StartupProfile, Match } from "../types";

// Regression: a local model answering with a bare {id,score,...} object
// instead of an array must still yield an assessment and a streamed match.

const QUERY_VEC = [1, 0, 0];

const corpus: Opportunity[] = [
  {
    id: "grants-1",
    source: "grants.gov",
    kind: "grant",
    program: "Program One",
    agency: "NSF",
    description: "Foundational research funding.",
    eligibility: "Open to small businesses.",
    embedding: [1, 0, 0],
  },
  {
    id: "grants-2",
    source: "grants.gov",
    kind: "grant",
    program: "Program Two",
    agency: "DoD",
    description: "Applied research funding.",
    eligibility: "Open to small businesses.",
    embedding: [1, 0, 0],
  },
];

const profile: StartupProfile = { description: "We build sensing hardware.", employees: 12 };

const savedProvider = process.env.LLM_PROVIDER;
const savedBatch = process.env.LLM_BATCH_SIZE;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedBatch === undefined) delete process.env.LLM_BATCH_SIZE;
  else process.env.LLM_BATCH_SIZE = savedBatch;
  globalThis.fetch = realFetch;
});

const deps: Partial<BuildDeps> = {
  corpus,
  extractProfile: async () => ({ profile, followUps: [] }),
  embed: async () => QUERY_VEC,
  explainMatches,
  explainWeakField: async () => ({
    headline: "No strong federal match yet",
    reasoning: "Your work is early for the programs in scope.",
    redirects: [],
  }),
  screen: realScreen,
};

test("local bare-object scoring response: onMatch still fires per candidate and no match is dropped", async () => {
  process.env.LLM_PROVIDER = "ollama";
  delete process.env.LLM_BATCH_SIZE;

  let call = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const userContent: string = body.messages.find((m: any) => m.role === "user")?.content ?? "";
    const id = corpus.find((c) => userContent.includes(`"${c.id}"`))?.id ?? `unknown-${call}`;
    call++;
    const bareAssessment = {
      id,
      score: 80,
      tier: "likely",
      criteria: [],
      whyCare: "Funds exactly this work.",
      whyFit: "Strong technical alignment.",
      whyIneligible: "Confirm entity type and registration.",
      whatToVerify: "SAM registration.",
      whatToDoNext: "Register in SAM.gov.",
    };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(bareAssessment) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    };
  }) as unknown as typeof fetch;

  const previewed: Match[] = [];
  const map = await buildOpportunityMap(
    profile.description,
    undefined,
    deps,
    undefined,
    undefined,
    undefined,
    (m) => previewed.push(m),
  );

  assert.equal(call, corpus.length, "one scoring call per candidate at local batch size 1");
  assert.equal(
    previewed.length,
    corpus.length,
    "onMatch (progressive rendering) must fire once per scored candidate, not zero",
  );
  assert.deepEqual(
    previewed.map((m) => m.opportunity.id).sort(),
    corpus.map((c) => c.id).sort(),
  );
  assert.equal(map.matches.length, corpus.length, "no match may be dropped from the final assembly");
});
