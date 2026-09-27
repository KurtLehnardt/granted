import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { explainMatchesTwoPass, type Assessment } from "../claude";
import type { Opportunity, StartupProfile } from "../types";

/**
 * E3 — local models: Pass A and Pass B each run ONE candidate per call,
 * serially, and Pass B narrates only the top `E3_TWO_PASS_TOP_N` candidates
 * (by Pass-A score) that clear `PROMOTION_FLOOR`. Exercises the REAL
 * `explainMatchesTwoPass` (no buildOpportunityMap/screen/embed involved) with
 * a stubbed OpenAI-compatible fetch — no network, no live Ollama model.
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
const savedTopN = process.env.E3_TWO_PASS_TOP_N;
const savedPassABatch = process.env.LLM_PASS_A_BATCH_SIZE;
const savedPassBBatch = process.env.LLM_PASS_B_BATCH_SIZE;
const realFetch = globalThis.fetch;

afterEach(() => {
  for (const [key, saved] of [
    ["LLM_PROVIDER", savedProvider],
    ["E3_TWO_PASS_TOP_N", savedTopN],
    ["LLM_PASS_A_BATCH_SIZE", savedPassABatch],
    ["LLM_PASS_B_BATCH_SIZE", savedPassBBatch],
  ] as const) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  globalThis.fetch = realFetch;
});

/** SCORES span above/below PROMOTION_FLOOR (25) so promotion is meaningful. */
const SCORES: Record<string, number> = {
  "opp-a": 90,
  "opp-b": 80,
  "opp-c": 40, // clears the floor but should NOT be narrated when topN=2
  "opp-d": 10, // below the floor — never eligible for narration
};
const candidates = Object.keys(SCORES).map(opp);

/** Optional `delayMs` + `inFlight` tracker let a test prove calls run SERIALLY
 *  (never more than one in flight at once) rather than merely counting them —
 *  a concurrent `Promise.allSettled` fan-out still passes a plain call-count
 *  assertion but would push `inFlight` above 1. */
function fakeFetch(
  calls: { passA: string[]; passB: string[] },
  opts: { delayMs?: number; inFlight?: { current: number; max: number }; pool?: Opportunity[] } = {},
): typeof fetch {
  const pool = opts.pool ?? candidates;
  return (async (_url: string, init: any) => {
    if (opts.inFlight) {
      opts.inFlight.current += 1;
      opts.inFlight.max = Math.max(opts.inFlight.max, opts.inFlight.current);
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const body = JSON.parse(init.body);
    const userContent: string = body.messages.find((m: any) => m.role === "user")?.content ?? "";
    const id = pool.find((c) => userContent.includes(`"${c.id}"`))?.id;
    if (!id) throw new Error("test fixture could not identify the candidate in the request body");
    // Pass A's score-only prompt asks for a tiny max_tokens (1024); Pass B's
    // full-narrative prompt asks for 8000 — route the stub response the same
    // way `lib/claude.ts` distinguishes the two calls.
    const isPassA = body.max_tokens <= 1024;
    let content: unknown;
    if (isPassA) {
      calls.passA.push(id);
      content = { id, score: SCORES[id] };
    } else {
      calls.passB.push(id);
      content = {
        id,
        score: SCORES[id],
        tier: "likely",
        criteria: [],
        whyCare: `care ${id}`,
        whyFit: `fit ${id}`,
        whyIneligible: `verify ${id}`,
        whatToVerify: `check ${id}`,
        whatToDoNext: `next ${id}`,
      };
    }
    if (opts.inFlight) opts.inFlight.current -= 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    };
  }) as unknown as typeof fetch;
}

test("local: Pass A and Pass B each run one candidate per call, serially", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.E3_TWO_PASS_TOP_N = "8"; // every floor-clearer gets narrated
  delete process.env.LLM_PASS_A_BATCH_SIZE;
  delete process.env.LLM_PASS_B_BATCH_SIZE;

  const calls = { passA: [] as string[], passB: [] as string[] };
  globalThis.fetch = fakeFetch(calls);

  const previews: Assessment[] = [];
  const result = await explainMatchesTwoPass(
    profile,
    candidates,
    undefined,
    undefined,
    undefined,
    (a) => previews.push(a),
  );

  // One Pass-A call per candidate.
  assert.equal(calls.passA.length, candidates.length);
  assert.deepEqual(new Set(calls.passA), new Set(candidates.map((c) => c.id)));
  // Pass B narrated only the 3 candidates clearing PROMOTION_FLOOR (25): a, b, c.
  assert.equal(calls.passB.length, 3);
  assert.deepEqual(new Set(calls.passB), new Set(["opp-a", "opp-b", "opp-c"]));

  // No candidate dropped, even though every response was a bare object.
  assert.equal(result.length, candidates.length);
  assert.deepEqual(new Set(result.map((r) => r.id)), new Set(candidates.map((c) => c.id)));
  const below = result.find((r) => r.id === "opp-d")!;
  assert.equal(below.score, 10);
  assert.equal(below.whyFit, "", "below the floor: score-only, no narrative spend");
});

test("local: Pass A and Pass B calls never overlap (truly serial, not a concurrent fan-out)", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.E3_TWO_PASS_TOP_N = "8";
  delete process.env.LLM_PASS_A_BATCH_SIZE;
  delete process.env.LLM_PASS_B_BATCH_SIZE;

  const calls = { passA: [] as string[], passB: [] as string[] };
  const inFlight = { current: 0, max: 0 };
  globalThis.fetch = fakeFetch(calls, { delayMs: 5, inFlight });

  await explainMatchesTwoPass(profile, candidates);

  assert.equal(inFlight.max, 1, "a concurrent (Promise.allSettled) fan-out would push this above 1");
  assert.equal(calls.passA.length, candidates.length);
  assert.equal(calls.passB.length, 3);
});

test("local: Pass B narrates promoted candidates in score order, independent of the input candidate order", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.E3_TWO_PASS_TOP_N = "8";
  delete process.env.LLM_PASS_A_BATCH_SIZE;
  delete process.env.LLM_PASS_B_BATCH_SIZE;

  // Deliberately NOT in score order (unlike the module-level `candidates`,
  // whose insertion order happens to already match score-descending) — a
  // regression that dropped the `.sort()` in `selectPassBCandidates` would
  // narrate in THIS (input) order instead and fail the assertion below.
  const shuffled = [opp("opp-c"), opp("opp-d"), opp("opp-a"), opp("opp-b")];

  const calls = { passA: [] as string[], passB: [] as string[] };
  globalThis.fetch = fakeFetch(calls, { pool: shuffled });

  await explainMatchesTwoPass(profile, shuffled);

  assert.deepEqual(calls.passB, ["opp-a", "opp-b", "opp-c"], "narrated highest Pass-A score first, regardless of input order");
});

test("local: Pass B narrates only the top N promoted candidates, in score order", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.E3_TWO_PASS_TOP_N = "2";
  delete process.env.LLM_PASS_A_BATCH_SIZE;
  delete process.env.LLM_PASS_B_BATCH_SIZE;

  const calls = { passA: [] as string[], passB: [] as string[] };
  globalThis.fetch = fakeFetch(calls);

  const result = await explainMatchesTwoPass(profile, candidates, undefined, undefined, undefined, undefined);

  // Only the top 2 by Pass-A score (a=90, b=80) get narrated; c (40) clears the
  // floor but loses out to the cap.
  assert.deepEqual(calls.passB, ["opp-a", "opp-b"]);

  const byId = new Map(result.map((r) => [r.id, r]));
  assert.equal(byId.get("opp-a")!.whyFit, "fit opp-a");
  assert.equal(byId.get("opp-b")!.whyFit, "fit opp-b");
  // c cleared the floor but was capped out of Pass B — still appears, score-only.
  assert.equal(byId.get("opp-c")!.whyFit, "", "capped out of Pass B, but never dropped");
  assert.equal(byId.get("opp-c")!.score, 40);
  assert.equal(result.length, candidates.length, "no candidate dropped by the top-N cap");
});

test("local: onAssessment fires the Pass-A score before the Pass-B narrative for a promoted candidate", async () => {
  process.env.LLM_PROVIDER = "ollama";
  process.env.E3_TWO_PASS_TOP_N = "8";
  delete process.env.LLM_PASS_A_BATCH_SIZE;
  delete process.env.LLM_PASS_B_BATCH_SIZE;

  const calls = { passA: [] as string[], passB: [] as string[] };
  globalThis.fetch = fakeFetch(calls);

  const previews: Assessment[] = [];
  await explainMatchesTwoPass(profile, candidates, undefined, undefined, undefined, (a) => previews.push(a));

  const aPreviews = previews.filter((p) => p.id === "opp-a");
  assert.equal(aPreviews.length, 2, "score-only, then the full narrative");
  assert.equal(aPreviews[0].whyFit, "", "first emit is score-only (no narrative yet)");
  assert.equal(aPreviews[0].score, 90);
  assert.equal(aPreviews[1].whyFit, "fit opp-a", "second emit carries the full narrative");

  const dPreviews = previews.filter((p) => p.id === "opp-d");
  assert.equal(dPreviews.length, 1, "never promoted: only the one score-only emit");
});
