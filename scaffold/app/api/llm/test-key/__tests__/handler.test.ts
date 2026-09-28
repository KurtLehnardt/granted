import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { handleTestKeyPost, type TestKeyDeps } from "../handler";
import type { CloudConfig } from "@/lib/llm/config";
import type { ProbeOutcome } from "@/lib/llm/cloudModels";
import { MODEL } from "@/lib/claude";

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
    resolveCloudConfig: () => undefined,
    probeCloudKey: (async () => ({ ok: true }) as ProbeOutcome) as any,
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

  test("malformed draft key -> 400 format error, no provider call", async () => {
    let called = false;
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcdefghijklmnop…" } }),
      fakeDeps({ probeCloudKey: (async () => { called = true; return { ok: true }; }) as any }),
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /doesn't look like a valid/);
    assert.equal(called, false);
  });

  test("unknown providerId -> 400", async () => {
    const res = await handleTestKeyPost(fakeReq({ providerId: "not-a-provider", keySource: { type: "inline", key: "x" } }), fakeDeps());
    assert.equal(res.status, 400);
  });

  test("'other' provider requires a valid https base URL", async () => {
    const draft = { providerId: "other", keySource: { type: "inline", key: "a-perfectly-fine-key" } };
    const missing = await handleTestKeyPost(fakeReq(draft), fakeDeps());
    assert.equal(missing.status, 400);

    const badUrl = await handleTestKeyPost(fakeReq({ ...draft, baseUrl: "http://insecure.example.com" }), fakeDeps());
    assert.equal(badUrl.status, 400);
  });

  test("uses the saved config when no draft is provided, stubbed probe -> { ok: true }", async () => {
    let sent: any;
    const savedCloud: CloudConfig = { providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } };
    const res = await handleTestKeyPost(
      fakeReq({}),
      fakeDeps({
        resolveCloudConfig: () => savedCloud,
        probeCloudKey: (async (params: any) => { sent = params; return { ok: true }; }) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(sent.key, "sk-savedopenaikey0000");
    assert.equal(sent.providerId, "openai");
  });

  test("uses a provided (not-yet-saved) draft over the saved config", async () => {
    let sentKey: string | undefined;
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "groq", keySource: { type: "inline", key: "gsk-draftkeyvalue0000" } }),
      fakeDeps({
        resolveCloudConfig: () => ({ providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } }),
        probeCloudKey: (async (params: any) => { sentKey = params.key; return { ok: true }; }) as any,
      }),
    );
    await res.json();
    assert.equal(sentKey, "gsk-draftkeyvalue0000");
  });

  test("env key source: unset variable -> 400 'isn't set', no provider call", async () => {
    delete process.env.GRANTED_TEST_KEY_UNSET;
    let called = false;
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "openai", keySource: { type: "env", name: "GRANTED_TEST_KEY_UNSET" } }),
      fakeDeps({ probeCloudKey: (async () => { called = true; return { ok: true }; }) as any }),
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /isn't set/);
    assert.equal(called, false);
  });

  test("probe reports invalid key -> 200 { ok: false }, distinct from a format error", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-badbutwellformed00" } }),
      fakeDeps({ probeCloudKey: (async () => ({ ok: false, kind: "invalid_key", message: "That key didn't work. Double-check it and try again." })) as any }),
    );
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, false);
    assert.match(json.error, /didn't work/i);
  });

  test("probe reports rate limit -> distinct message", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-goodwellformed0000" } }),
      fakeDeps({ probeCloudKey: (async () => ({ ok: false, kind: "rate_limited", message: "rate-limiting requests" })) as any }),
    );
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /rate.?limit/i);
  });

  test("probe reports a network error -> distinct message", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-goodwellformed0000" } }),
      fakeDeps({ probeCloudKey: (async () => ({ ok: false, kind: "network", message: "Couldn't reach the provider's API." })) as any }),
    );
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.match(json.error, /couldn't reach/i);
  });

  test("never echoes the key back in the response", async () => {
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "openai", keySource: { type: "inline", key: "sk-secretvaluenotecho" } }),
      fakeDeps({ probeCloudKey: (async () => ({ ok: false, kind: "invalid_key", message: "nope" })) as any }),
    );
    const json = await res.json();
    assert.equal(JSON.stringify(json).includes("sk-secretvaluenotecho"), false);
  });

  test("draft keySource {type:'saved'} reuses the saved key for the same provider", async () => {
    let sentKey: string | undefined;
    const savedCloud: CloudConfig = { providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } };
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "openai", keySource: { type: "saved" } }),
      fakeDeps({
        resolveCloudConfig: () => savedCloud,
        probeCloudKey: (async (params: any) => { sentKey = params.key; return { ok: true }; }) as any,
      }),
    );
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(sentKey, "sk-savedopenaikey0000");
  });

  test("'other': the saved key is never sent to a different base URL", async () => {
    let probed = false;
    const savedCloud: CloudConfig = { providerId: "other", baseUrl: "https://a.example.com/v1", keySource: { type: "inline", key: "saved-other-key-0000" } };
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "other", baseUrl: "https://b.example.com/v1", keySource: { type: "saved" } }),
      fakeDeps({ resolveCloudConfig: () => savedCloud, probeCloudKey: (async () => { probed = true; return { ok: true }; }) as any }),
    );
    assert.equal(res.status, 400);
    assert.equal(probed, false);
  });

  test("draft keySource {type:'saved'} after a provider switch -> 400, no saved key reused", async () => {
    const savedCloud: CloudConfig = { providerId: "openai", keySource: { type: "inline", key: "sk-savedopenaikey0000" } };
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "groq", keySource: { type: "saved" } }),
      fakeDeps({ resolveCloudConfig: () => savedCloud }),
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error, "Please enter a key for your cloud provider.");
  });

  test("draft anthropicWorkspaceId is passed through to probeCloudKey", async () => {
    let sent: any;
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" }, anthropicWorkspaceId: "wrkspc_abc123" }),
      fakeDeps({ probeCloudKey: (async (params: any) => { sent = params; return { ok: true }; }) as any }),
    );
    await res.json();
    assert.equal(res.status, 200);
    assert.equal(sent.anthropicWorkspaceId, "wrkspc_abc123");
  });

  test("no draft anthropicWorkspaceId -> undefined is passed through (no header sent)", async () => {
    let sent: any;
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } }),
      fakeDeps({ probeCloudKey: (async (params: any) => { sent = params; return { ok: true }; }) as any }),
    );
    await res.json();
    assert.equal(res.status, 200);
    assert.equal(sent.anthropicWorkspaceId, undefined);
  });

  test("anthropic draft with no model probes the app's default search model", async () => {
    let sent: any;
    await handleTestKeyPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" } }),
      fakeDeps({ probeCloudKey: (async (params: any) => { sent = params; return { ok: true }; }) as any }),
    );
    assert.equal(sent.model, MODEL);
  });

  test("non-anthropic draft with no model leaves the fallback to probeCloudKey", async () => {
    let sent: any;
    await handleTestKeyPost(
      fakeReq({ providerId: "mistral", keySource: { type: "inline", key: "key0000000000000000" } }),
      fakeDeps({ probeCloudKey: (async (params: any) => { sent = params; return { ok: true }; }) as any }),
    );
    assert.equal(sent.model, undefined);
  });

  test("invalid draft anthropicWorkspaceId shape -> 400, no provider call", async () => {
    let called = false;
    const res = await handleTestKeyPost(
      fakeReq({ providerId: "anthropic", keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" }, anthropicWorkspaceId: "not-valid" }),
      fakeDeps({ probeCloudKey: (async () => { called = true; return { ok: true }; }) as any }),
    );
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(json.error, /Workspace ID/);
    assert.equal(called, false);
  });

  test("saved anthropicWorkspaceId is used when testing the saved config (no draft)", async () => {
    let sent: any;
    const savedCloud: CloudConfig = {
      providerId: "anthropic",
      keySource: { type: "inline", key: "sk-ant-abcXYZ1234567890" },
      anthropicWorkspaceId: "wrkspc_saved000",
    };
    const res = await handleTestKeyPost(
      fakeReq({}),
      fakeDeps({ resolveCloudConfig: () => savedCloud, probeCloudKey: (async (params: any) => { sent = params; return { ok: true }; }) as any }),
    );
    await res.json();
    assert.equal(sent.anthropicWorkspaceId, "wrkspc_saved000");
  });
});
