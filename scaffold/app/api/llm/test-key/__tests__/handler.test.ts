import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
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

  test("401 -> invalid key message", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ anthropicApiKey: "sk-ant-badkey00000000" }),
      fakeDeps({
        makeAnthropicClientForKey: (() => ({
          messages: {
            create: async () => {
              throw new Anthropic.AuthenticationError(401, { message: "invalid x-api-key" }, "invalid x-api-key", {});
            },
          },
        })) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /didn't work/i);
  });

  test("429 -> rate limit message, distinct from an invalid key", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ anthropicApiKey: "sk-ant-goodkey0000000" }),
      fakeDeps({
        makeAnthropicClientForKey: (() => ({
          messages: {
            create: async () => {
              throw new Anthropic.RateLimitError(429, { message: "rate limited" }, "rate limited", {});
            },
          },
        })) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /rate.?limit/i);
    assert.doesNotMatch(json.error, /didn't work/i);
  });

  test("529 overload -> temporarily unavailable message, distinct from an invalid key", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ anthropicApiKey: "sk-ant-goodkey0000000" }),
      fakeDeps({
        makeAnthropicClientForKey: (() => ({
          messages: {
            create: async () => {
              throw new Anthropic.InternalServerError(529, { message: "overloaded" }, "overloaded", {});
            },
          },
        })) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /unavailable/i);
    assert.doesNotMatch(json.error, /didn't work/i);
  });

  test("network error -> couldn't reach Anthropic message, distinct from an invalid key", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ anthropicApiKey: "sk-ant-goodkey0000000" }),
      fakeDeps({
        makeAnthropicClientForKey: (() => ({
          messages: {
            create: async () => {
              throw new Anthropic.APIConnectionError({ message: "connection error" });
            },
          },
        })) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /couldn't reach/i);
    assert.doesNotMatch(json.error, /didn't work/i);
  });
});
