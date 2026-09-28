import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { looksLikeKeyOrAuthError } from "../IntakeForm";

/**
 * The search-error banner offers an "Open Settings" action only when the
 * failure actually looks like a key/auth/billing problem (Settings is where
 * the fix lives) -- see IntakeForm.tsx's doc comment on the function.
 */
describe("looksLikeKeyOrAuthError — error-banner Settings-link gating", () => {
  test("matches the real provider messages this was built for", () => {
    assert.equal(looksLikeKeyOrAuthError("API key is invalid."), true);
    assert.equal(looksLikeKeyOrAuthError("Incorrect API key provided."), true);
    assert.equal(looksLikeKeyOrAuthError("credit balance is too low"), true);
    assert.equal(looksLikeKeyOrAuthError("Your credit balance is too low to access the Claude API."), true);
    assert.equal(looksLikeKeyOrAuthError("Authentication failed."), true);
    assert.equal(looksLikeKeyOrAuthError("401 Unauthorized"), true);
  });

  test("is case-insensitive and matches an api-key phrasing with a hyphen or space", () => {
    assert.equal(looksLikeKeyOrAuthError("your API-KEY is missing"), true);
    assert.equal(looksLikeKeyOrAuthError("your api key is missing"), true);
  });

  // The doc comment names Anthropic, OpenAI, Gemini, OpenRouter, Groq,
  // Mistral -- these are each provider's OWN real error text (not a generic
  // phrasing guess), since a genuinely representative string is the only
  // thing that would have caught the OpenRouter gap a prior review round
  // found (its actual bodies don't say "api key" or "authentication" at all).
  test("matches OpenRouter's real 401/402 bodies", () => {
    assert.equal(looksLikeKeyOrAuthError("No auth credentials found"), true);
    assert.equal(
      looksLikeKeyOrAuthError("Insufficient credits. Add more using https://openrouter.ai/credits"),
      true,
    );
  });

  test("matches OpenAI's real quota-exhaustion message (a 429, not phrased as a key/auth error)", () => {
    assert.equal(
      looksLikeKeyOrAuthError("You exceeded your current quota, please check your plan and billing details."),
      true,
    );
  });

  test("does NOT fire for unrelated failures -- Settings wouldn't fix these", () => {
    assert.equal(looksLikeKeyOrAuthError("The search didn't complete — please try again."), false);
    assert.equal(looksLikeKeyOrAuthError("fetch failed"), false);
    assert.equal(looksLikeKeyOrAuthError("rate limit exceeded, retry in 30s"), false);
    assert.equal(looksLikeKeyOrAuthError("Request timed out."), false);
    assert.equal(looksLikeKeyOrAuthError("Internal server error"), false);
  });

  test("KNOWN TRADEOFF: can false-positive if a provider ever echoes user content containing a matched word", () => {
    // lib/llm/errors.ts's sanitizeProviderMessage only redacts literal key
    // material -- it can't rule out a provider reflecting part of the
    // request into a 4xx body. Pinned here as accepted (see the doc
    // comment): the failure mode is an extra, harmless "Open Settings"
    // button, not a dead end -- not a regression to "fix" by narrowing this
    // into missing real provider errors again.
    assert.equal(
      looksLikeKeyOrAuthError("We build authentication middleware and API key management tooling for enterprises."),
      true,
    );
  });
});
