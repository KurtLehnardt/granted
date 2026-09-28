import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleTestKeyPost, type TestKeyDeps } from "../handler";

function fakeReq(body?: unknown): { headers: { get(name: string): string | null }; json: () => Promise<unknown> } {
  return {
    headers: { get: () => null },
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  };
}

function fakeDeps(overrides: Partial<TestKeyDeps> = {}): TestKeyDeps {
  return {
    isLoopbackRequest: () => true,
    resolveAnthropicKey: () => undefined,
    makeAnthropicClientForKey: (() => ({
      messages: { create: async () => ({ content: [{ type: "text", text: "hi" }] }) },
    })) as any,
    ...overrides,
  };
}

describe("POST /api/llm/test-key", () => {
  test("403 when not loopback", async () => {
    const res = await handleTestKeyPost(fakeReq({}), fakeDeps({ isLoopbackRequest: () => false }));
    assert.equal(res.status, 403);
  });

  test("400 when there's no saved or provided key", async () => {
    const res = await handleTestKeyPost(fakeReq({}), fakeDeps());
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.ok, false);
  });

  test("uses the saved key when none is provided, stubbed SDK -> { ok: true }", async () => {
    let usedKey: string | undefined;
    const res = await handleTestKeyPost(
      fakeReq({}),
      fakeDeps({
        resolveAnthropicKey: () => "sk-ant-savedkey0000000",
        makeAnthropicClientForKey: ((key: string) => {
          usedKey = key;
          return { messages: { create: async () => ({}) } };
        }) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(usedKey, "sk-ant-savedkey0000000");
  });

  test("uses a provided (not-yet-saved) key over the saved one", async () => {
    let usedKey: string | undefined;
    const res = await handleTestKeyPost(
      fakeReq({ anthropicApiKey: "sk-ant-draftkey0000000" }),
      fakeDeps({
        resolveAnthropicKey: () => "sk-ant-savedkey0000000",
        makeAnthropicClientForKey: ((key: string) => {
          usedKey = key;
          return { messages: { create: async () => ({}) } };
        }) as any,
      }),
    );
    await res.json();
    assert.equal(usedKey, "sk-ant-draftkey0000000");
  });

  test("SDK failure -> { ok: false, error } without echoing the key", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ anthropicApiKey: "sk-ant-badkey00000000" }),
      fakeDeps({
        makeAnthropicClientForKey: (() => ({
          messages: {
            create: async () => {
              throw new Error("401 sk-ant-badkey00000000 invalid x-api-key");
            },
          },
        })) as any,
      }),
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, false);
    assert.equal(typeof json.error, "string");
    assert.equal(json.error.includes("sk-ant-badkey00000000"), false);
  });
});
