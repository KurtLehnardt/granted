import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_PROVIDERS, getCloudProvider, isCloudProviderId, isValidHttpsUrl } from "../providers";

describe("CLOUD_PROVIDERS registry", () => {
  test("has exactly the seven required presets", () => {
    assert.deepEqual(
      CLOUD_PROVIDERS.map((p) => p.id).sort(),
      ["anthropic", "google", "groq", "mistral", "openai", "openrouter", "other"],
    );
  });

  test("every non-Anthropic, non-Other preset ships a fixed https base URL", () => {
    for (const p of CLOUD_PROVIDERS) {
      if (p.id === "anthropic" || p.id === "other") continue;
      assert.equal(typeof p.baseUrl, "string");
      assert.equal(isValidHttpsUrl(p.baseUrl!), true, `${p.id} base URL should be https`);
    }
  });

  test("anthropic and other ship no fixed base URL", () => {
    assert.equal(getCloudProvider("anthropic")?.baseUrl, undefined);
    assert.equal(getCloudProvider("other")?.baseUrl, undefined);
  });

  test("isCloudProviderId narrows correctly", () => {
    assert.equal(isCloudProviderId("openai"), true);
    assert.equal(isCloudProviderId("bedrock"), false);
    assert.equal(isCloudProviderId(42), false);
  });
});

describe("per-provider key format checks", () => {
  test("anthropic: strict sk-ant- prefix, length bounds", () => {
    const p = getCloudProvider("anthropic")!;
    assert.equal(p.isKeyValid("sk-ant-abcXYZ1234567890"), true);
    assert.equal(p.isKeyValid("sk-abcXYZ1234567890000"), false); // openai-shaped, not anthropic
    assert.equal(p.isKeyValid("sk-ant-x"), false); // too short
    assert.equal(p.isKeyValid("sk-ant-" + "a".repeat(200)), false); // too long
  });

  test("openai: sk- prefix, length bounds, no whitespace", () => {
    const p = getCloudProvider("openai")!;
    assert.equal(p.isKeyValid("sk-abcXYZ1234567890000"), true);
    assert.equal(p.isKeyValid("not-sk-prefixed-key000"), false);
    assert.equal(p.isKeyValid("sk-with a space in it0"), false);
    assert.equal(p.isKeyValid("sk-x"), false);
  });

  test("generic providers (google/openrouter/groq/mistral/other): non-empty, no whitespace, length bounds", () => {
    for (const id of ["google", "openrouter", "groq", "mistral", "other"] as const) {
      const p = getCloudProvider(id)!;
      assert.equal(p.isKeyValid("a-reasonable-key-value"), true, id);
      assert.equal(p.isKeyValid(""), false, id);
      assert.equal(p.isKeyValid("has a space"), false, id);
      assert.equal(p.isKeyValid("short"), false, id);
      assert.equal(p.isKeyValid("x".repeat(500)), false, id);
    }
  });
});

describe("isValidHttpsUrl", () => {
  test("accepts https, rejects http and garbage", () => {
    assert.equal(isValidHttpsUrl("https://example.com/v1"), true);
    assert.equal(isValidHttpsUrl("http://example.com/v1"), false);
    assert.equal(isValidHttpsUrl("not a url"), false);
    assert.equal(isValidHttpsUrl(""), false);
  });
});
