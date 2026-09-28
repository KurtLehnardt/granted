import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeCloudKey, listCloudModels } from "../cloudModels";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeCloudKey — OpenAI-compatible providers", () => {
  test("GET {base}/models with a bearer token, then one minimal message with the configured model; 200 -> ok", async () => {
    const calls: { url: string; auth: string }[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.Authorization });
      if (url.endsWith("/chat/completions")) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: "hi" } }] }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    const outcome = await probeCloudKey({ providerId: "openai", key: "sk-goodkey0000000000", model: "gpt-4o" });
    assert.equal(outcome.ok, true);
    assert.equal(calls[0].url, "https://api.openai.com/v1/models");
    assert.equal(calls[0].auth, "Bearer sk-goodkey0000000000");
    assert.equal(calls[1].url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[1].auth, "Bearer sk-goodkey0000000000");
  });

  test("models list ok, but the message probe hits a credit-balance 400 -> surfaces that message, not ok", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/chat/completions")) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: "Your credit balance is too low to access the API." } }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    const outcome = await probeCloudKey({ providerId: "openai", key: "sk-goodkey0000000000", model: "gpt-4o" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.match(outcome.message, /credit balance is too low/);
  });

  test("a reasoning model rejecting max_tokens is retried with max_completion_tokens, like the search shim", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      if (url.endsWith("/chat/completions")) {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if ("max_tokens" in body) {
          return { ok: false, status: 400, text: async () => "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." };
        }
        return { ok: true, json: async () => ({ choices: [] }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    const outcome = await probeCloudKey({ providerId: "openai", key: "sk-goodkey0000000000", model: "gpt-5-mini" });
    assert.equal(outcome.ok, true);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].max_completion_tokens, 1);
  });

  test("models list ok, but the message probe 404s the model -> invalid_model, not a key error", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/chat/completions")) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;

    const outcome = await probeCloudKey({ providerId: "openai", key: "sk-goodkey0000000000", model: "not-a-real-model" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.kind, "invalid_model");
      assert.match(outcome.message, /not-a-real-model/);
      assert.doesNotMatch(outcome.message, /didn't work/i);
    }
  });

  test("no configured model, no provider default, none listed -> key-only ok, no message probe", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return { ok: true, json: async () => ({ data: [] }) }; }) as unknown as typeof fetch;
    const outcome = await probeCloudKey({ providerId: "mistral", key: "key0000000000000000" });
    assert.equal(outcome.ok, true);
    assert.equal(calls, 1, "no model to probe against — must not guess one");
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
  test("valid key and model -> ok, via GET /v1/models then one minimal message call", async () => {
    const { withHostedFetch } = await import("../client");
    const calledUrls: string[] = [];
    await withHostedFetch((async (url: any) => {
      const u = url.toString();
      calledUrls.push(u);
      if (u.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "hi" }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any, async () => {
      const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
      assert.equal(outcome.ok, true);
    });
    assert.ok(calledUrls.some((u) => /\/v1\/models/.test(u)));
    assert.ok(calledUrls.some((u) => /\/v1\/messages/.test(u)));
  });

  // Real-world finding: models.list is free and succeeds even with $0 credit —
  // only an actual message call reveals a credit-balance/billing problem.
  test("models list ok, but the message probe hits a credit-balance 400 -> surfaces that message", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch((async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as any, async () => {
      const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "claude-x" });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.message, /credit balance is too low/);
    });
  });

  test("a mistyped/nonexistent model -> invalid_model (key works, model doesn't), not invalid_key", async () => {
    const { withHostedFetch } = await import("../client");
    await withHostedFetch((async (url: any) => {
      const u = url.toString();
      if (u.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { type: "not_found_error", message: "model: not-a-real-model" } }), { status: 404, headers: { "content-type": "application/json" } });
    }) as any, async () => {
      const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890", model: "not-a-real-model" });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.kind, "invalid_model");
        assert.match(outcome.message, /not-a-real-model/);
        assert.doesNotMatch(outcome.message, /didn't work/i);
      }
    });
  });

  test("no model configured, none listed -> key-only ok, no message probe", async () => {
    const { withHostedFetch } = await import("../client");
    let calls = 0;
    await withHostedFetch((async () => {
      calls++;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any, async () => {
      const outcome = await probeCloudKey({ providerId: "anthropic", key: "sk-ant-abcXYZ1234567890" });
      assert.equal(outcome.ok, true);
    });
    assert.equal(calls, 1, "no model to probe against — must not guess one");
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

  test("400 not-scoped-to-workspace -> surfaces the provider message, sanitized, with a create-key-in-a-workspace nudge", async () => {
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
          assert.match(outcome.message, /isn't tied to a workspace/);
          assert.match(outcome.message, /open a workspace/);
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

describe("fcc (Anthropic-compatible proxy): Test key / Load models auth", () => {
  const TOKEN = "fcc-token-value-0000";

  function header(init: any, name: string): string | undefined {
    const h = init?.headers ?? {};
    if (typeof h.get === "function") return h.get(name) ?? undefined;
    return Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1] as string | undefined;
  }

  async function withPaidKeyInEnv(fn: () => Promise<void>): Promise<void> {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-paidkeyvalue000";
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }

  function recordingFetch(calls: { url: string; method: string; auth?: string; apiKey?: string; model?: string }[]) {
    return (async (url: any, init: any) => {
      const u = url.toString();
      calls.push({
        url: u,
        method: String(init?.method ?? "GET").toUpperCase(),
        auth: header(init, "authorization"),
        apiKey: header(init, "x-api-key"),
        model: init?.body ? JSON.parse(init.body).model : undefined,
      });
      const body = u.includes("/v1/models") ? { data: [{ id: "claude-sonnet-4-20250514" }] } : { id: "msg_1", content: [{ type: "text", text: "hi" }], usage: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
  }

  test("probeCloudKey: Bearer only (ANTHROPIC_API_KEY ignored) to <default base>/v1/models then /v1/messages with the default model", async () => {
    const { withHostedFetch } = await import("../client");
    const calls: Parameters<typeof recordingFetch>[0] = [];
    await withPaidKeyInEnv(() =>
      withHostedFetch(recordingFetch(calls), async () => {
        const outcome = await probeCloudKey({ providerId: "fcc", key: TOKEN });
        assert.equal(outcome.ok, true);
      }),
    );
    assert.deepEqual(
      calls.map((c) => [c.method, c.url.split("?")[0]]),
      [["GET", "http://127.0.0.1:8082/v1/models"], ["POST", "http://127.0.0.1:8082/v1/messages"]],
    );
    for (const c of calls) {
      assert.equal(c.auth, `Bearer ${TOKEN}`);
      assert.equal(c.apiKey, undefined);
    }
    assert.equal(calls[1].model, "claude-sonnet-4-20250514");
  });

  test("probeCloudKey: a user-entered base URL is used as-is (no /v1 doubling)", async () => {
    const { withHostedFetch } = await import("../client");
    const calls: Parameters<typeof recordingFetch>[0] = [];
    await withPaidKeyInEnv(() =>
      withHostedFetch(recordingFetch(calls), async () => {
        await probeCloudKey({ providerId: "fcc", key: TOKEN, baseUrl: "http://localhost:9000/" });
      }),
    );
    assert.deepEqual(calls.map((c) => c.url.split("?")[0]), ["http://localhost:9000/v1/models", "http://localhost:9000/v1/messages"]);
    assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}` && c.apiKey === undefined));
  });

  test("listCloudModels: Bearer only (ANTHROPIC_API_KEY ignored) to <base>/v1/models", async () => {
    const { withHostedFetch } = await import("../client");
    const calls: Parameters<typeof recordingFetch>[0] = [];
    await withPaidKeyInEnv(() =>
      withHostedFetch(recordingFetch(calls), async () => {
        const result = await listCloudModels({ providerId: "fcc", key: TOKEN, baseUrl: "http://127.0.0.1:8082" });
        assert.deepEqual(result.models, ["claude-sonnet-4-20250514"]);
      }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.split("?")[0], "http://127.0.0.1:8082/v1/models");
    assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
    assert.equal(calls[0].apiKey, undefined);
  });
});
