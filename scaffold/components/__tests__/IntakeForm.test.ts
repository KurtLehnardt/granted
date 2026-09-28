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

  test("does NOT fire for unrelated failures -- Settings wouldn't fix these", () => {
    assert.equal(looksLikeKeyOrAuthError("The search didn't complete — please try again."), false);
    assert.equal(looksLikeKeyOrAuthError("fetch failed"), false);
    assert.equal(looksLikeKeyOrAuthError("rate limit exceeded, retry in 30s"), false);
    assert.equal(looksLikeKeyOrAuthError("Request timed out."), false);
    assert.equal(looksLikeKeyOrAuthError("Internal server error"), false);
  });
});
