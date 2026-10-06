import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import { handleMatchRequest, type MatchDeps } from "../handler";
import type { OpportunityMap } from "@/lib/types";
import { ProviderHttpError, markChatError } from "@/lib/llm/errors";
import { __resetRateLimits } from "@/lib/security/rateLimit";

// Every case is a fresh client: the per-IP limit (20/min) isn't what these test.
beforeEach(() => __resetRateLimits());

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
// old code buried behind "The search didn't complete." Now it says what to do.
test("a provider 400 (Anthropic credit-balance error) says the account is out of credits and how to fix it", async () => {
  // Thrown by the chat client, which marks its errors as the chat provider's.
  const providerErr = markChatError(Anthropic.APIError.generate(
    400,
    { error: { message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } },
    undefined,
    {},
  ));
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw providerErr; },
    cloudProviderName: () => "Anthropic",
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.ok(err);
  assert.equal(err.error, "Your Anthropic account is out of credits — add credits, or switch to Local in Settings → Model.");
  assert.doesNotMatch(err.error, /didn't complete/);
});

test("an OpenAI-compatible 402 (ProviderHttpError) is reported as out of credits for that provider", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => {
      throw markChatError(new ProviderHttpError(402, JSON.stringify({ error: { message: "Insufficient balance for this request." } })));
    },
    cloudProviderName: () => "OpenAI",
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const lines = await readLines(res);
  const err = lines.find((l) => l.type === "error");
  assert.match(err.error, /^Your OpenAI account is out of credits/);
});

test("a revoked key (401) says the key was rejected and where to update it", async () => {
  const providerErr = markChatError(Anthropic.APIError.generate(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, {}));
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw providerErr; },
    cloudProviderName: () => "Anthropic",
  });
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.match(err.error, /Anthropic API key was rejected/);
  assert.match(err.error, /Settings → Model/);
});

test("an unrecognized provider 4xx still surfaces its sanitized message", async () => {
  const deps: MatchDeps = {
    cached: () => undefined,
    buildOpportunityMap: async () => {
      throw new ProviderHttpError(400, JSON.stringify({ error: { message: "max_tokens is too large for this model." } }));
    },
    cloudProviderName: () => "OpenAI",
  };
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), deps);
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.equal(err.error, "max_tokens is too large for this model.");
});

test("Local: Ollama unreachable before the search -> says to start it in Settings → Model, never calls the model", async () => {
  let built = false;
  const { LocalSetupError } = await import("@/lib/llm/searchErrors");
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => { built = true; return fakeMap; },
    resolveLlm: async () => { throw new LocalSetupError("ollama_unreachable"); },
  });
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.match(err.error, /couldn't reach Ollama/);
  assert.match(err.error, /start it in Settings → Model/);
  assert.equal(built, false);
});

test("Local: only embedding models installed -> says to download a chat model", async () => {
  const { LocalSetupError } = await import("@/lib/llm/searchErrors");
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => fakeMap,
    resolveLlm: async () => { throw new LocalSetupError("no_chat_models"); },
  });
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.match(err.error, /no chat model installed/);
  assert.match(err.error, /Settings → Model/);
});

test("Local: a pick that isn't installed is said in the progress label, and the search runs on Default", async () => {
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION, model: "gone:3b" })), {
    cached: () => undefined,
    buildOpportunityMap: async () => fakeMap,
    resolveLlm: async (m, onStatus) => { onStatus(`Your pick ${m} isn't installed; using qwen2.5:7b.`); return { local: true, model: "qwen2.5:7b" }; },
  });
  const lines = await readLines(res);
  assert.ok(lines.some((l) => l.type === "progress" && l.label === "Your pick gone:3b isn't installed; using qwen2.5:7b."));
  assert.equal(lines.at(-1).type, "result");
});

test("a provider error NOT from the chat client (e.g. an embeddings 401) isn't blamed on the chat provider", async () => {
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => {
      throw new ProviderHttpError(401, JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    },
    cloudProviderName: () => "Anthropic",
  });
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.doesNotMatch(err.error, /Anthropic/);
});

test("the fcc proxy (loopback base URL) down -> 'is the proxy running', not 'check your internet connection'", async () => {
  const conn = markChatError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw conn; },
    resolveLlm: async () => ({ local: false }),
    cloudProviderName: () => "proxy",
    cloudBaseUrl: () => "http://127.0.0.1:8082",
  });
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.match(err.error, /proxy at http:\/\/127\.0\.0\.1:8082 — is it running\?/);
});

test("Local: Ollama stopping mid-search (fetch failed, wrapped by the batch fan-out) -> 'couldn't reach Ollama'", async () => {
  const conn = markChatError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) }));
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => { throw new Error("All scoring batches failed: fetch failed", { cause: conn }); },
    resolveLlm: async () => ({ local: true, model: "llama3.2:1b" }),
  });
  const err = (await readLines(res)).find((l) => l.type === "error");
  assert.match(err.error, /couldn't reach Ollama/);
});

test("Local: the preflight's 'Starting Ollama…' status streams as progress before the search", async () => {
  const res = await handleMatchRequest(post(JSON.stringify({ description: VALID_DESCRIPTION })), {
    cached: () => undefined,
    buildOpportunityMap: async () => fakeMap,
    resolveLlm: async (_m, onStatus) => { onStatus("Starting Ollama…"); return { local: true, model: "llama3.2:1b" }; },
  });
  const lines = await readLines(res);
  assert.ok(lines.some((l) => l.type === "progress" && l.label === "Starting Ollama…"));
  assert.equal(lines.at(-1).type, "result");
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
