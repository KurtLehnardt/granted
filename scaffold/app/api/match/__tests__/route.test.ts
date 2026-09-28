import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import { handleMatchRequest, type MatchDeps } from "../handler";
import type { OpportunityMap } from "@/lib/types";
import { ProviderHttpError } from "@/lib/llm/errors";

/**
 * NDJSON /api/match route tests (H6). `handleMatchRequest` is the pure
 * request→Response core the Next `POST` forwards to; here it's called with a
 * plain Request and a mocked buildOpportunityMap/cached, so validation, the
 * cache short-circuit, NDJSON framing, and the mid-stream error path are all
 * exercised in-process — no network, no model spend.
 */

const VALID_DESCRIPTION =
  "We build AI-assisted diagnostics for rural clinics and need federal funding.";

function post(body: string): Request {
  return new Request("http://localhost/api/match", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Drain a streamed Response into parsed NDJSON lines (JSON.parse throws if a
 *  line isn't independently parseable — that IS the framing assertion). */
async function readLines(res: Response): Promise<any[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    if (done) break; // reaching done proves the stream closes, never hangs
  }
  buf += dec.decode();
  return buf
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const fakeMap = {
  profile: { description: VALID_DESCRIPTION },
  followUps: [],
  summary: { highPotential: 1, fundingIdentified: 0, agencies: 1, closingIn90Days: 0 },
  matches: [],
  agencyIntelligence: [],
} as unknown as OpportunityMap;

test("missing description → 400 JSON, not a stream", async () => {
  const res = await handleMatchRequest(post(JSON.stringify({})), {
    cached: () => undefined,
    buildOpportunityMap: async () => fakeMap,
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const j = await res.json();
  assert.ok(j.error);
});

test("description under 20 chars → 400 JSON", async () => {
  const res = await handleMatchRequest(post(JSON.stringify({ description: "too short" })), {
    cached: () => undefined,
    buildOpportunityMap: async () => fakeMap,
  });
  assert.equal(res.status, 400);
});

test("invalid JSON body → 400 JSON", async () => {
  const res = await handleMatchRequest(post("{ not valid json"), {
    cached: () => undefined,
    buildOpportunityMap: async () => fakeMap,
  });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.ok(j.error);
});

test("a precomputed cache hit returns the cached map via one progress + one result line, without calling buildOpportunityMap", async () => {
  let buildCalls = 0;
  const deps: MatchDeps = {
    cached: () => fakeMap,
    buildOpportunityMap: async () => {
      buildCalls++;
      return fakeMap;
    },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  assert.equal(buildCalls, 0, "cache hit must not invoke buildOpportunityMap");
  assert.equal(lines.filter((l) => l.type === "result").length, 1);
  assert.ok(lines.some((l) => l.type === "progress"));
});

test("NDJSON stream: every line parses; a progress line precedes exactly one terminal result; pct non-decreasing", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async (_desc, onStep) => {
      onStep?.({ key: "start", label: "a", pct: 5 });
      onStep?.({ key: "score", label: "b", pct: 50 });
      onStep?.({ key: "assemble", label: "c", pct: 90 });
      return fakeMap;
    },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  assert.match(res.headers.get("content-type") ?? "", /x-ndjson/);
  const lines = await readLines(res); // throws if any line isn't valid JSON

  const results = lines.filter((l) => l.type === "result");
  assert.equal(results.length, 1, "exactly one result line terminates the stream");
  const resultIdx = lines.findIndex((l) => l.type === "result");
  assert.ok(
    lines.slice(0, resultIdx).some((l) => l.type === "progress"),
    "a progress line must precede the result",
  );
  assert.equal(resultIdx, lines.length - 1, "the result is the last line");

  const pcts = lines.filter((l) => l.type === "progress").map((l) => l.pct);
  for (let i = 1; i < pcts.length; i++) {
    assert.ok(pcts[i] >= pcts[i - 1], "progress pct must be non-decreasing");
  }
});

test("buildOpportunityMap throwing mid-stream emits a type:'error' line and the stream still closes cleanly", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => {
      throw new Error("kaboom");
    },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res); // returning at all proves it closed (no hang)
  const errs = lines.filter((l) => l.type === "error");
  assert.equal(errs.length, 1);
  assert.ok(errs[0].error && typeof errs[0].error === "string" && errs[0].error.length > 0);
  assert.equal(lines.filter((l) => l.type === "result").length, 0);
});

// Real-world finding: a key with no credit passes Test key / Load models
// (models.list is free) and every search then fails with a provider 400 the
// old code buried behind "The search didn't complete." — this is the fix.
test("a provider 400 (e.g. Anthropic credit-balance error) surfaces the sanitized provider message, not the generic text", async () => {
  const providerErr = Anthropic.APIError.generate(
    400,
    { error: { message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } },
    undefined,
    {},
  );
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw providerErr; },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.ok(err);
  assert.match(err.error, /credit balance is too low/);
  assert.doesNotMatch(err.error, /didn't complete/);
});

test("an OpenAI-compatible provider 4xx (ProviderHttpError) also surfaces its sanitized message", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => {
      throw new ProviderHttpError(402, JSON.stringify({ error: { message: "Insufficient balance for this request." } }));
    },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.equal(err.error, "Insufficient balance for this request.");
});

test("a ProviderHttpError 4xx with an HTML body keeps the generic message", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => {
      throw new ProviderHttpError(403, "<html><body>Forbidden</body></html>");
    },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.equal(err.error, "The search didn't complete. Please try again.");
});

test("a provider 5xx keeps the generic message — no raw provider internals shown", async () => {
  const providerErr = Anthropic.APIError.generate(500, { error: { message: "internal engine failure, host db-7, trace abc123" } }, undefined, {});
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw providerErr; },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.equal(err.error, "The search didn't complete. Please try again.");
  assert.doesNotMatch(err.error, /db-7/);
});

test("an unknown/non-provider error keeps the generic message", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw new Error("kaboom"); },
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.equal(err.error, "The search didn't complete. Please try again.");
});

test("a COMPLETED map that fails OpportunityMap schema still streams a result — never dead-ends the search", async () => {
  // Regression for the boundary-validation dead-end: a live map that doesn't
  // satisfy the (over-strict) schema must still be streamed to the client, not
  // converted into 'The search didn't complete.' (that broke ~2/3 of novel
  // searches in prod). Validation is observability-only.
  const brokenButRenderable = {
    summary: { highPotential: "not-a-number" }, // wrong type → fails schema
    matches: [],
  } as unknown as OpportunityMap;
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => brokenButRenderable,
  });
  const lines = await readLines(res);
  const results = lines.filter((l) => l.type === "result");
  assert.equal(lines.filter((l) => l.type === "error").length, 0, "must not dead-end on schema strictness");
  assert.equal(results.length, 1, "a finished search must stream its result");
  assert.equal(
    results[0].map.summary.highPotential,
    "not-a-number",
    "streams the ORIGINAL map (additive fields intact), not a stripped parsed.data",
  );
});
