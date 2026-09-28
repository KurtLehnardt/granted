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

  test("'other' provider: a trailing slash in the base URL doesn't double up", async () => {
    let sentUrl = "";
    globalThis.fetch = (async (url: string) => { sentUrl = url; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1/", key: "k", model: "" });
    assert.equal(sentUrl, "https://my-proxy.example.com/v1/models");
  });

  test("openrouter probes the authenticated /key endpoint (its /models is public)", async () => {
    let sentUrl = "";
    globalThis.fetch = (async (url: string) => {
      sentUrl = url;
      return { ok: false, status: 401 };
    }) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "openrouter", key: "sk-or-badkey000000", model: "" });
    assert.equal(sentUrl, "https://openrouter.ai/api/v1/key");
    assert.equal(outcome.ok, false);
  });

  test("404 gets its own message, not 'That key didn't work'", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key: "k", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.message, /endpoint not found/i);
  });

  test("other 4xx (e.g. 400) surfaces the provider's own message instead of the generic one", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "This API key is not scoped to a workspace." } }),
    })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key: "sk-mysecretkeyvalue0", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /not scoped to a workspace/);
      assert.doesNotMatch(outcome.message, /didn't work/i);
    }
  });

  test("other 4xx: a key embedded in the provider's message is redacted", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ error: { message: "Billing issue for key sk-mysecretkeyvalue0" } }),
    })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key: "sk-mysecretkeyvalue0", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.doesNotMatch(outcome.message, /sk-mysecretkeyvalue0/);
      assert.match(outcome.message, /\[redacted\]/);
    }
  });

  test("other 4xx: message is capped at ~300 chars", async () => {
    const long = "x".repeat(1000);
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: long } }),
    })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key: "k", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.ok(outcome.message.length <= 305);
  });

  test("other 4xx: a non-sk- key echoed in a plain-text body is redacted", async () => {
    const key = "gsk_Live0123456789abcdefXYZ";
    globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => `Bad request for Authorization: Bearer ${key}` })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key, model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.message.includes(key), false);
      assert.match(outcome.message, /\[redacted\]/);
    }
  });

  test("other 4xx: an HTML error page falls back to the generic message", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 400, text: async () => "<html><body>400 Bad Request</body></html>" })) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "other", baseUrl: "https://my-proxy.example.com/v1", key: "sk-mysecretkeyvalue0", model: "" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.message, /didn't work/i);
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

// Anthropic goes through the SDK, whose fetch is only reachable via the
// AsyncLocalStorage seam in client.ts (see cloudClient.test.ts).
describe("probeCloudKey — anthropic", () => {
  test("valid key -> ok, via GET /v1/models (never spends a completion)", async () => {
    const { withHostedFetch } = await import("../client");
    let calledUrl = "";
    await withHostedFetch((async (url: any) => {
      calledUrl = url.toString();
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any, async () => {
      const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
      assert.equal(outcome.ok, true);
    });
    assert.match(calledUrl, /\/v1\/models/);
  });

  test("a mistyped/nonexistent model never affects the probe (no messages.create call at all)", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch((async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } })) as any, async () => {
      const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "not-a-real-model" });
      assert.equal(outcome.ok, true);
    });
  });

  test("401 -> invalid_key", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch(
      (async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } })) as any,
      async () => {
        const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-badkey00000000", model: "claude-x" });
        assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.equal(outcome.kind, "invalid_key");
      },
    );
  });

  test("429 -> rate_limited", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch(
      (async () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), { status: 429, headers: { "content-type": "application/json" } })) as any,
      async () => {
        const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
        assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.equal(outcome.kind, "rate_limited");
      },
    );
  });

  test("400 not-scoped-to-workspace -> surfaces the provider message, sanitized, with a nudge to fill in Workspace ID", async () => {
    const { withHostedFetch } = await import("../client");
    const providerMessage =
      "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.";
    await withHostedFetch(
      (async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: providerMessage } }), { status: 400, headers: { "content-type": "application/json" } })) as any,
      async () => {
        const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
        assert.equal(outcome.ok, false);
        if (!outcome.ok) {
          assert.equal(outcome.kind, "other");
          assert.match(outcome.message, /not scoped to a workspace/);
          assert.match(outcome.message, /Check the Workspace ID field/);
        }
      },
    );
  });

  test("400: a key embedded in the provider's message is redacted", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch(
      (async () =>
        new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Bad key sk-ant-abcXYZ1234567890 supplied" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as any,
      async () => {
        const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
        assert.equal(outcome.ok, false);
        if (!outcome.ok) {
          assert.doesNotMatch(outcome.message, /sk-ant-abcXYZ1234567890/);
          assert.match(outcome.message, /\[redacted\]/);
        }
      },
    );
  });

  test("sends anthropic-workspace-id when a workspace id is given", async () => {
    const { withHostedFetch } = await import("../client");
    let sentHeader: string | null = null;
    await withHostedFetch(
      (async (_url: any, init: any) => {
        sentHeader = init?.headers?.["anthropic-workspace-id"] ?? null;
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as any,
      async () => {
        await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x", anthropicWorkspaceId: "wrkspc_abc123" });
      },
    );
    assert.equal(sentHeader, "wrkspc_abc123");
  });

  test("no anthropic-workspace-id header when none is given", async () => {
    const { withHostedFetch } = await import("../client");
    let sentHeader: string | null | undefined = "unset";
    await withHostedFetch(
      (async (_url: any, init: any) => {
        sentHeader = init?.headers?.["anthropic-workspace-id"];
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as any,
      async () => {
        await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
      },
    );
    assert.equal(sentHeader, undefined);
  });
});

describe("listCloudModels — anthropic", () => {
  test("parses model ids off the SDK's models.list() page", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch(
      (async () => new Response(JSON.stringify({ data: [{ id: "claude-opus-4" }, { id: "claude-haiku-4-5" }] }), { status: 200, headers: { "content-type": "application/json" } })) as any,
      async () => {
        const result = await listCloudModels({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890" });
        assert.deepEqual(result.models, ["claude-opus-4", "claude-haiku-4-5"]);
      },
    );
  });

  test("401 -> error, no models", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch(
      (async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } })) as any,
      async () => {
        const result = await listCloudModels({ providerId: "anthropic", key: "sk-ant-badkey00000000" });
        assert.equal(result.models, undefined);
        assert.match(result.error!, /didn't work/i);
      },
    );
  });

  test("sends anthropic-workspace-id when a workspace id is given", async () => {
    const { withHostedFetch } = await import("../client");
    let sentHeader: string | undefined;
    await withHostedFetch(
      (async (_url: any, init: any) => {
        sentHeader = init?.headers?.["anthropic-workspace-id"];
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as any,
      async () => {
        await listCloudModels({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", anthropicWorkspaceId: "wrkspc_abc123" });
      },
    );
    assert.equal(sentHeader, "wrkspc_abc123");
  });

  test("400 not-scoped-to-workspace -> provider message with the key redacted", async () => {
    const { withHostedFetch } = await import("../client");
    const key = "sk-ant-api03-Zz9Yy8Xx7Ww6Vv5Uu4Tt3-AA";
    await withHostedFetch(
      (async () =>
        new Response(JSON.stringify({ error: { type: "invalid_request_error", message: `Key ${key} is not scoped to a workspace.` } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as any,
      async () => {
        const result = await listCloudModels({ providerId: "anthropic", key });
        assert.equal(result.models, undefined);
        assert.equal(result.error!.includes(key), false);
        assert.equal(result.error!.includes("Zz9Yy8Xx7Ww6"), false);
        assert.match(result.error!, /not scoped to a workspace/);
      },
    );
  });
});
