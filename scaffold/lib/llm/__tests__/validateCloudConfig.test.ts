import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateCloudConfig, resolveDraftKey } from "../validateCloudConfig";

describe("validateCloudConfig", () => {
  test("unknown providerId -> error", () => {
    const r = validateCloudConfig({ providerId: "bedrock", keySource: { type: "inline", key: "x" } });
    assert.match(r.error!, /Choose a cloud provider/);
  });

  test("no keySource at all -> the inline 'please enter a key' message", () => {
    const r = validateCloudConfig({ providerId: "anthropic" });
    assert.equal(r.error, "Please enter a key for your cloud provider.");
  });

  test("empty inline key -> the same message", () => {
    const r = validateCloudConfig({ providerId: "anthropic", keySource: { type: "inline", key: "   " } });
    assert.equal(r.error, "Please enter a key for your cloud provider.");
  });

  test("valid anthropic key -> config with trimmed key, no baseUrl", () => {
    const r = validateCloudConfig({ providerId: "anthropic", keySource: { type: "inline", key: " sk-ant-abcXYZ1234567890 " } });
    assert.deepEqual(r.config, { providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } });
  });

  test("'other' provider without a base URL -> error", () => {
    const r = validateCloudConfig({ providerId: "other", keySource: { type: "inline", key: "a-fine-key-value" } });
    assert.match(r.error!, /base URL/);
  });

  test("'other' provider with an http (not https) base URL -> error", () => {
    const r = validateCloudConfig({
      providerId: "other",
      baseUrl: "http://example.com/v1",
      keySource: { type: "inline", key: "a-fine-key-value" },
    });
    assert.match(r.error!, /https/);
  });

  test("'other' provider with a valid https base URL -> succeeds", () => {
    const r = validateCloudConfig({
      providerId: "other",
      baseUrl: "https://example.com/v1",
      model: "custom-model",
      keySource: { type: "inline", key: "a-fine-key-value" },
    });
    assert.equal(r.config?.baseUrl, "https://example.com/v1");
  });

  test("provider with no default model and none given -> error", () => {
    for (const providerId of ["openrouter", "mistral", "other"]) {
      const r = validateCloudConfig({
        providerId,
        baseUrl: "https://example.com/v1",
        keySource: { type: "inline", key: "a-fine-key-value" },
      });
      assert.match(r.error!, /model/i, providerId);
    }
  });

  test("provider with no default model, but a model given -> succeeds", () => {
    const r = validateCloudConfig({
      providerId: "openrouter",
      model: "some/model",
      keySource: { type: "inline", key: "a-fine-key-value" },
    });
    assert.equal(r.config?.model, "some/model");
  });

  test("anthropic (no default model either) doesn't require one", () => {
    const r = validateCloudConfig({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } });
    assert.equal(r.error, undefined);
  });

  test("keySource {type:'saved'} reuses the given saved key source for the same provider", () => {
    const currentCloud = { providerId: "openai" as const, model: "gpt-4o", keySource: { type: "inline" as const, key: "sk-savedopenaikey0000" } };
    const r = validateCloudConfig({ providerId: "openai", model: "gpt-4o", keySource: { type: "saved" } }, currentCloud);
    assert.deepEqual(r.config?.keySource, { type: "inline", key: "sk-savedopenaikey0000" });
  });

  test("keySource {type:'saved'} with no matching saved provider -> the inline 'please enter a key' message", () => {
    const currentCloud = { providerId: "openai" as const, keySource: { type: "inline" as const, key: "sk-savedopenaikey0000" } };
    const r = validateCloudConfig({ providerId: "groq", model: "llama-3.3-70b", keySource: { type: "saved" } }, currentCloud);
    assert.equal(r.error, "Please enter a key for your cloud provider.");
  });

  test("omitted keySource falls back to the saved one for the same provider", () => {
    const currentCloud = { providerId: "openai" as const, model: "gpt-4o", keySource: { type: "inline" as const, key: "sk-savedopenaikey0000" } };
    const r = validateCloudConfig({ providerId: "openai", model: "gpt-4o-mini" }, currentCloud);
    assert.deepEqual(r.config?.keySource, { type: "inline", key: "sk-savedopenaikey0000" });
  });

  test("model is trimmed and persisted when given", () => {
    const r = validateCloudConfig({ providerId: "groq", model: "  llama-3.3-70b  ", keySource: { type: "inline", key: "a-fine-key-value" } });
    assert.equal(r.config?.model, "llama-3.3-70b");
  });

  test("model omitted -> undefined, not persisted", () => {
    const r = validateCloudConfig({ providerId: "groq", keySource: { type: "inline", key: "a-fine-key-value" } });
    assert.equal(r.config?.model, undefined);
  });

  test("a posted anthropicWorkspaceId is ignored (field removed)", () => {
    const r = validateCloudConfig({
      providerId: "anthropic",
      keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" },
      anthropicWorkspaceId: "wrkspc_abc123",
    } as any);
    assert.equal(r.error, undefined);
    assert.equal("anthropicWorkspaceId" in (r.config ?? {}), false);
  });
});

describe("resolveDraftKey", () => {
  test("env source: unset -> error", () => {
    delete process.env.GRANTED_VALIDATE_TEST_UNSET;
    const r = resolveDraftKey("openai", { type: "env", name: "GRANTED_VALIDATE_TEST_UNSET" });
    assert.match(r.error!, /isn't set/);
  });

  test("env source: set but fails the provider's format check -> format error, not the raw resolve error", () => {
    process.env.GRANTED_VALIDATE_TEST_BAD = "totally-not-openai-shaped-but-long-enough";
    const r = resolveDraftKey("openai", { type: "env", name: "GRANTED_VALIDATE_TEST_BAD" });
    assert.match(r.error!, /doesn't look like a valid OpenAI/);
    delete process.env.GRANTED_VALIDATE_TEST_BAD;
  });
});
