import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleModelsPost, type ModelsDeps } from "../handler";

function fakeReq(body?: unknown): { headers: { get(name: string): string | null }; json: () => Promise<unknown> } {
  return {
    headers: { get: () => null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function fakeDeps(overrides: Partial<ModelsDeps> = {}): ModelsDeps {
  return {
    isLoopbackRequest: () => true,
    listCloudModels: (async () => ({ models: ["a", "b"] })) as any,
    ...overrides,
  };
}

describe("POST /api/llm/models", () => {
  test("403 when not loopback", async () => {
    const res = await handleModelsPost(fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-x" } }), fakeDeps({ isLoopbackRequest: () => false }));
    assert.equal(res.status, 403);
  });

  test("400 on invalid providerId", async () => {
    const res = await handleModelsPost(fakeReq({ providerId: "nope" }), fakeDeps());
    assert.equal(res.status, 400);
  });

  test("400 on malformed draft key, no listCloudModels call", async () => {
    let called = false;
    const res = await handleModelsPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "not-anthropic-shaped" } }),
      fakeDeps({ listCloudModels: (async () => { called = true; return {}; }) as any }),
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  test("populates the model list once the key resolves", async () => {
    let sent: any;
    const res = await handleModelsPost(
      fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-abcXYZ1234567890000" } }),
      fakeDeps({ listCloudModels: (async (p: any) => { sent = p; return { models: ["gpt-4o"] }; }) as any }),
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(json.models, ["gpt-4o"]);
    assert.equal(sent.key, "sk-abcXYZ1234567890000");
    assert.equal(sent.providerId, "openai");
  });

  test("'other' provider requires a valid https base URL before calling out", async () => {
    const res = await handleModelsPost(fakeReq({ providerId: "other", keySource: { type: "inline", key: "a-fine-key-value" } }), fakeDeps());
    assert.equal(res.status, 400);
  });

  test("never echoes the key back in the response", async () => {
    const res = await handleModelsPost(
      fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-secretkeynotecho00" } }),
      fakeDeps(),
    );
    const json = await res.json();
    assert.equal(JSON.stringify(json).includes("sk-secretkeynotecho00"), false);
  });
});
