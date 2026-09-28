import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_PROVIDERS, getCloudProvider, isCloudProviderId, isSameCloudTarget, isValidHttpsUrl, isValidCloudBaseUrl } from "../providers";

describe("CLOUD_PROVIDERS registry", () => {
  test("has exactly the eight required presets", () => {
    assert.deepEqual(
      CLOUD_PROVIDERS.map((p) => p.id).sort(),
      ["anthropic", "fcc", "google", "groq", "mistral", "openai", "openrouter", "other"],
    );
  });

  test("every preset with a fixed (non-editable) base URL ships a valid https URL", () => {
    for (const p of CLOUD_PROVIDERS) {
      if (p.editableBaseUrl || !p.baseUrl) continue;
      assert.equal(isValidHttpsUrl(p.baseUrl), true, `${p.id} base URL should be https`);
    }
  });

  test("anthropic and other ship no base URL at all; fcc ships an editable default", () => {
    assert.equal(getCloudProvider("anthropic")?.baseUrl, undefined);
    assert.equal(getCloudProvider("other")?.baseUrl, undefined);
    assert.equal(getCloudProvider("fcc")?.baseUrl, "http://127.0.0.1:8082");
    assert.equal(getCloudProvider("fcc")?.editableBaseUrl, true);
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

  test("generic providers (google/openrouter/groq/mistral/fcc/other): non-empty, no whitespace, length bounds", () => {
    for (const id of ["google", "openrouter", "groq", "mistral", "fcc", "other"] as const) {
      const p = getCloudProvider(id)!;
      assert.equal(p.isKeyValid("a-reasonable-key-value"), true, id);
      assert.equal(p.isKeyValid(""), false, id);
      assert.equal(p.isKeyValid("has a space"), false, id);
      assert.equal(p.isKeyValid("short"), false, id);
      assert.equal(p.isKeyValid("x".repeat(500)), false, id);
    }
  });
});

describe("isSameCloudTarget", () => {
  test("same preset provider -> same target; different provider -> not", () => {
    assert.equal(isSameCloudTarget({ providerId: "openai" }, "openai"), true);
    assert.equal(isSameCloudTarget({ providerId: "openai" }, "groq"), false);
    assert.equal(isSameCloudTarget(undefined, "openai"), false);
  });

  test("'other' also needs the same base URL, compared after normalization", () => {
    const saved = { providerId: "other" as const, baseUrl: "https://a.example.com/v1" };
    assert.equal(isSameCloudTarget(saved, "other", "https://a.example.com/v1/"), true);
    assert.equal(isSameCloudTarget(saved, "other", "https://b.example.com/v1"), false);
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

describe("isValidCloudBaseUrl — http allowed only for a loopback host on an allowHttpLoopbackOnly preset", () => {
  const fcc = getCloudProvider("fcc")!;
  const other = getCloudProvider("other")!;

  test("https always works, for any editable-base-URL preset", () => {
    assert.equal(isValidCloudBaseUrl("https://example.com", fcc), true);
    assert.equal(isValidCloudBaseUrl("https://example.com", other), true);
  });

  test("http works for fcc on localhost/127.0.0.1/[::1]", () => {
    assert.equal(isValidCloudBaseUrl("http://127.0.0.1:8082", fcc), true);
    assert.equal(isValidCloudBaseUrl("http://localhost:8082", fcc), true);
    assert.equal(isValidCloudBaseUrl("http://[::1]:8082", fcc), true);
  });

  test("http is rejected for fcc on a non-loopback host", () => {
    assert.equal(isValidCloudBaseUrl("http://example.com:8082", fcc), false);
    assert.equal(isValidCloudBaseUrl("http://192.168.1.5:8082", fcc), false);
  });

  test("http is rejected for a preset that doesn't allow it, even on loopback", () => {
    assert.equal(isValidCloudBaseUrl("http://127.0.0.1:8082", other), false);
  });

  test("garbage is rejected", () => {
    assert.equal(isValidCloudBaseUrl("not a url", fcc), false);
  });
});

describe("fcc preset — Anthropic-compatible proxy shape", () => {
  const fcc = getCloudProvider("fcc")!;

  test("routes through the Anthropic SDK with authToken (Authorization: Bearer), not apiKey", () => {
    assert.equal(fcc.usesAnthropicSdk, true);
    assert.equal(fcc.authMode, "authToken");
  });

  test("defaults to a loopback base URL, a mapped Claude model id, and gentle concurrency", () => {
    assert.equal(fcc.baseUrl, "http://127.0.0.1:8082");
    assert.equal(fcc.defaultModel, "claude-sonnet-4-20250514");
    assert.equal(fcc.concurrency, 2);
  });

  test("defaults its key source to the per-install token file", () => {
    assert.deepEqual(fcc.defaultKeySource, { type: "file", path: "~/.fcc/proxy_auth_token" });
  });

  test("ships a one-line privacy note", () => {
    assert.equal(fcc.privacyNote, "Prompts are forwarded to third-party free providers, which may log them.");
  });

  test("groq and openrouter also get gentler free-tier concurrency; hosted anthropic/openai keep none set", () => {
    assert.equal(getCloudProvider("groq")?.concurrency, 2);
    assert.equal(getCloudProvider("openrouter")?.concurrency, 2);
    assert.equal(getCloudProvider("anthropic")?.concurrency, undefined);
    assert.equal(getCloudProvider("openai")?.concurrency, undefined);
  });
});

describe("isSameCloudTarget — fcc (editable base URL, Anthropic SDK) compares base URLs like 'other'", () => {
  test("same base URL -> same target; different base URL -> not", () => {
    const saved = { providerId: "fcc" as const, baseUrl: "http://127.0.0.1:8082" };
    assert.equal(isSameCloudTarget(saved, "fcc", "http://127.0.0.1:8082"), true);
    assert.equal(isSameCloudTarget(saved, "fcc", "http://127.0.0.1:9999"), false);
  });
});
