import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { explainMatchesTwoPass } from "../claude";
import { withHostedFetch } from "../llm/client";
import type { Opportunity, StartupProfile } from "../types";

/**
 * A sustained 429 must be retried ONLY by the client-level cap
 * (lib/llm/rateLimit.ts's withRetry429: 3 retries / 60s), which every
 * makeLlmClient() client is already wrapped in. The two-pass overload retry
 * (lib/claude.ts's withOverloadRetry) must NOT retry a 429 again on top of
 * that — stacking retries would blow both the 3-retry/60s cap and the
 * documented 45s/120s two-pass budget, and go against being gentle with
 * free-tier rate limits.
 */

function opp(id: string): Opportunity {
  return {
    id,
    source: "grants.gov",
    kind: "grant",
    program: `program ${id}`,
    agency: "TestAgency",
    description: `grant ${id}`,
    eligibility: "US small business.",
    embedding: [1, 0],
  };
}

const profile: StartupProfile = { description: "AI sensing hardware for federal customers.", employees: 20 };
const candidates = [opp("opp-0"), opp("opp-1")];

const savedProvider = process.env.LLM_PROVIDER;
const savedApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
});

test("a sustained 429 makes exactly 4 requests (1 + 3 client-level retries), not 16", async () => {
  delete process.env.LLM_PROVIDER; // hosted (anthropic)
  process.env.ANTHROPIC_API_KEY = "sk-ant-testkey00000000";

  // Make every backoff/sleep resolve on the next tick instead of really waiting.
  const originalSetTimeout = global.setTimeout;
  (global as any).setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as any;

  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(withHostedFetch(fetchImpl, () => explainMatchesTwoPass(profile, candidates)));
    // 2 candidates fit in a single Pass-A batch (size 12) -> one batch, one
    // client-level retry sequence: 1 initial attempt + 3 retries = 4 calls.
    assert.equal(calls, 4);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
