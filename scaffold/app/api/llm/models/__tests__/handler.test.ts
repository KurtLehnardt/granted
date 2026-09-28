import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleModelsPost, type ModelsDeps } from "../handler";
import type { CloudConfig } from "@/lib/llm/config";

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
    resolveCloudConfig: () => undefined,
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

  test("keySource {type:'saved'} reuses the saved key for the same provider", async () => {
    let sent: any;
    const savedCloud: CloudConfig = { providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } };
    const res = await handleModelsPost(
      fakeReq({ providerId: "openai", keySource: { type: "saved" } }),
      fakeDeps({
        resolveCloudConfig: () => savedCloud,
        listCloudModels: (async (p: any) => { sent = p; return { models: ["gpt-4o"] }; }) as any,
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(sent.key, "sk-savedopenaikey0000");
  });

  test("'other': the saved key is never sent to a different base URL", async () => {
    let called = false;
    const savedCloud: CloudConfig = { providerId: "other", baseUrl: "https://a.example.com/v1", keySource: { type: "inline", key: "saved-other-key-0000" } };
    const res = await handleModelsPost(
      fakeReq({ providerId: "other", baseUrl: "https://b.example.com/v1", keySource: { type: "saved" } }),
      fakeDeps({ resolveCloudConfig: () => savedCloud, listCloudModels: (async () => { called = true; return { models: [] }; }) as any }),
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  test("keySource {type:'saved'} does not carry over to a different provider -> 400", async () => {
    const savedCloud: CloudConfig = { providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } };
    const res = await handleModelsPost(
      fakeReq({ providerId: "groq", keySource: { type: "saved" } }),
      fakeDeps({ resolveCloudConfig: () => savedCloud }),
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error, "Please enter a key for your cloud provider.");
  });

  test("a posted anthropicWorkspaceId is not passed through to listCloudModels", async () => {
    let sent: any;
    const res = await handleModelsPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" }, anthropicWorkspaceId: "wrkspc_abc123" }),
      fakeDeps({ listCloudModels: (async (p: any) => { sent = p; return { models: [] }; }) as any }),
    );
    assert.equal(res.status, 200);
    assert.equal(sent.anthropicWorkspaceId, undefined);
  });
});
