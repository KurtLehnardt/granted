import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { explainMatches } from "../claude";
import type { Opportunity, StartupProfile } from "../types";

// A batch rejected in the fault-tolerant allSettled fan-out must leave a
// server-side trace: how many candidates it dropped, the provider status
// (when known), and a sanitized message — never the raw error, which could
// echo the API key back.

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
const FAKE_KEY = "sk-ant-test-secret-do-not-log-1234567890";

const savedProvider = process.env.LLM_PROVIDER;
const savedKey = process.env.LLM_API_KEY;
const savedBatch = process.env.LLM_BATCH_SIZE;
const realFetch = globalThis.fetch;
const realWarn = console.warn;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = savedKey;
  if (savedBatch === undefined) delete process.env.LLM_BATCH_SIZE;
  else process.env.LLM_BATCH_SIZE = savedBatch;
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

test("a rejected batch logs one warning with the dropped candidate count and status, never the key", async () => {
  process.env.LLM_PROVIDER = "ollama";
  delete process.env.LLM_API_KEY; // the client redacts its own key; the echoed token must be caught by the log sanitizer
  delete process.env.LLM_BATCH_SIZE; // local defaults to 1/batch, serial

  const candidates = [opp("a"), opp("b")];
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return { ok: false, status: 429, text: async () => `rate limited for key ${FAKE_KEY}` };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                id: "b", score: 80, tier: "likely", criteria: [],
                whyCare: "c", whyFit: "f", whyIneligible: "", whatToVerify: "v", whatToDoNext: "n",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    };
  }) as unknown as typeof fetch;

  const warnings: string[] = [];
  console.warn = ((...args: unknown[]) => { warnings.push(args.join(" ")); }) as typeof console.warn;

  const result = await explainMatches(profile, candidates);

  assert.equal(result.length, 1, "the surviving batch still scores");
  assert.equal(warnings.length, 1, "exactly one warning for the one rejected batch");
  assert.match(warnings[0], /1 candidate/);
  assert.match(warnings[0], /429/);
  assert.ok(!warnings[0].includes(FAKE_KEY), "the key must never be logged");
});
