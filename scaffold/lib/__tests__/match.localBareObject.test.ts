import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildOpportunityMap, type BuildDeps } from "../match";
import { explainMatches } from "../claude";
import { screen as realScreen } from "../eligibility/screen";
import type { Opportunity, StartupProfile, Match } from "../types";

/**
 * Regression for the local-model "bare object" bug: with `LLM_PROVIDER=ollama`,
 * the OpenAI-compat shim forces `response_format: json_object`
 * (lib/llm/client.ts), and a small local model (observed live against
 * qwen2.5:3b) sometimes answers a scoring batch with ONE bare
 * `{id,score,...}` object instead of the requested array — even for a
 * single-candidate batch (`LLM_BATCH_SIZE`/local default is 1). Before the
 * `asArray` fix in lib/claude.ts, `for (const a of batchAssessments)` in
 * `buildOpportunityMap` then threw "not iterable", which `runGroup`'s
 * best-effort try/catch silently swallowed — so `onMatch` never fired for
 * that candidate even though the final `assessments` array (via `ok.flat()`)
 * still happened to include it.
 *
 * This exercises the REAL `explainMatches` (not a stub) through the real
 * local shim, with `fetch` stubbed to return exactly that bare-object shape.
 */

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
const savedModel = process.env.LOCAL_LLM_MODEL;
const savedBatch = process.env.LLM_BATCH_SIZE;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedModel === undefined) delete process.env.LOCAL_LLM_MODEL;
  else process.env.LOCAL_LLM_MODEL = savedModel;
  if (savedBatch === undefined) delete process.env.LLM_BATCH_SIZE;
  else process.env.LLM_BATCH_SIZE = savedBatch;
  globalThis.fetch = realFetch;
});

function deps(over: Partial<BuildDeps> = {}): Partial<BuildDeps> {
  return {
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
    ...over,
  };
}

test("local bare-object scoring response: onMatch still fires per candidate and no match is dropped", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.LOCAL_LLM_MODEL = "qwen2.5:3b";
  delete process.env.LLM_BATCH_SIZE; // local default is 1/batch

  let call = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const userContent: string = body.messages.find((m: any) => m.role === "user")?.content ?? "";
    // Local batches are 1 candidate/call, serial and in corpus order — recover
    // which candidate this call is for from its own request body.
    const id = corpus.find((c) => userContent.includes(`"${c.id}"`))?.id ?? `unknown-${call}`;
    call++;
    // The observed live failure mode: a BARE object, not `[{...}]`.
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
    deps(),
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
