import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeCloudKey, listCloudModels } from "../cloudModels";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeCloudKey — OpenAI-compatible providers", () => {
  test("GET {base}/models with a bearer token; 200 -> ok", async () => {
    let sentUrl = "";
    let sentAuth = "";
    globalThis.fetch = (async (url: string, init: any) => {
      sentUrl = url;
      sentAuth = init.headers.Authorization;
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    const outcome = await probeCloudKey({ providerId: "openai", key: "sk-goodkey0000000000", model: "gpt-4o" });
    assert.equal(outcome.ok, true);
    assert.equal(sentUrl, "https://api.openai.com/v1/models");
    assert.equal(sentAuth, "Bearer sk-goodkey0000000000");
  });

  test("401 -> invalid_key", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "groq", key: "gsk-badkey0000000000", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "invalid_key");
  });

  test("429 -> rate_limited, distinct from invalid_key", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "groq", key: "gsk-key00000000000000", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "rate_limited");
  });

  test("network failure -> network", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "mistral", key: "key0000000000000000", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.kind, "network");
  });

  test("'other' provider uses the caller-supplied base URL", async () => {
    let sentUrl = "";
    globalThis.fetch = (async (url: string) => { sentUrl = url; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key: "k", model: "" });
    assert.equal(sentUrl, "https://my-proxy.example.com/v1/models");
  });
});

describe("listCloudModels", () => {
  test("OpenAI-compatible: parses {data:[{id}]} into a flat id list", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    })) as unknown as typeof fetch;
    const result = await listCloudModels({ providerId: "openai", key: "sk-x" });
    assert.deepEqual(result.models, ["gpt-4o", "gpt-4o-mini"]);
  });

  test("bearer header carries the resolved key", async () => {
    let sentAuth = "";
    globalThis.fetch = (async (_url: string, init: any) => {
      sentAuth = init.headers.Authorization;
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;
    await listCloudModels({ providerId: "openrouter", key: "sk-or-abc123" });
    assert.equal(sentAuth, "Bearer sk-or-abc123");
  });

  test("401 -> error, no models", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const result = await listCloudModels({ providerId: "openai", key: "sk-bad" });
    assert.equal(result.models, undefined);
    assert.match(result.error!, /didn't work/i);
  });

  test("network error -> error", async () => {
    globalThis.fetch = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    const result = await listCloudModels({ providerId: "openai", key: "sk-x" });
    assert.match(result.error!, /couldn't reach/i);
  });
});
