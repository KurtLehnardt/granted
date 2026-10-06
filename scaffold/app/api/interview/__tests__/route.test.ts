import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { __resetRateLimits } from "@/lib/security/rateLimit";

/**
 * FE-03 /api/interview route — the "never a 5xx" contract. `generateQuestions`
 * (INT-01) runs on the configured model provider (lib/llm); the route promises the
 * client it degrades to `{ questions: [] }` on ANY generation failure rather
 * than surfacing a 500, so a broken/slow interview never blocks the free
 * search path. Rate limits are reset per case so repeated calls in this file
 * never trip the per-IP 429 throttle.
 */

const VALID_DESCRIPTION =
  "We build AI-assisted diagnostics for rural clinics and need federal funding.";

function post(body: string): NextRequest {
  return new NextRequest("http://localhost/api/interview", {
    method: "POST",
    body,
  });
}

test("missing description -> 400", async () => {
  __resetRateLimits();
  const res = await POST(post(JSON.stringify({})));
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.ok(j.error);
});

test("description under 20 chars -> 400", async () => {
  __resetRateLimits();
  const res = await POST(post(JSON.stringify({ description: "too short" })));
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.ok(j.error);
});

test("invalid JSON body -> 400", async () => {
  __resetRateLimits();
  const res = await POST(post("{ not valid json"));
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.ok(j.error);
});

test("valid description with no model provider configured -> generation fails internally but the route still returns 200 with { questions: [] } (never a 5xx)", async () => {
  __resetRateLimits();
  const saved = process.env.OPENAI_API_KEY;
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedProvider = process.env.LLM_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_PROVIDER;
  try {
    const res = await POST(post(JSON.stringify({ description: VALID_DESCRIPTION })));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual(j, { questions: [] });
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = savedProvider;
  }
});
