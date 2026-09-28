import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { withRetry429, withConcurrencyLimit, getSharedLimiter } from "../rateLimit";
import { ProviderHttpError } from "../errors";

function anthropicRateLimitError(retryAfterHeader?: string): InstanceType<typeof Anthropic.APIError> {
  const headers = retryAfterHeader ? { "retry-after": retryAfterHeader } : {};
  return Anthropic.APIError.generate(429, { error: { message: "rate limited" } }, "rate limited", headers as any);
}

function client(create: (params: any, options?: any) => Promise<any>) {
  return { messages: { create } };
}

describe("withRetry429 — Anthropic SDK errors", () => {
  test("honors retry-after (seconds) then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const original = global.setTimeout;
    (global as any).setTimeout = ((fn: () => void, ms: number) => {
      waits.push(ms);
      return original(fn, 0);
    }) as any;
    try {
      const wrapped = withRetry429(
        client(async () => {
          calls++;
          if (calls === 1) throw anthropicRateLimitError("1"); // 1 second -> 1000ms
          return { ok: true };
        }),
      );
      const result = await wrapped.messages.create({});
      assert.deepEqual(result, { ok: true });
      assert.equal(calls, 2);
      assert.equal(waits[0], 1000);
    } finally {
      global.setTimeout = original;
    }
  });

  test("a non-429 error is never retried", async () => {
    let calls = 0;
    const wrapped = withRetry429(
      client(async () => {
        calls++;
        throw Anthropic.APIError.generate(400, { error: { message: "bad request" } }, "bad request", {} as any);
      }),
    );
    await assert.rejects(wrapped.messages.create({}));
    assert.equal(calls, 1);
  });

  test("stops after maxRetries attempts", async () => {
    let calls = 0;
    const wrapped = withRetry429(
      client(async () => {
        calls++;
        throw anthropicRateLimitError("0"); // no wait, so the test runs fast
      }),
      { maxRetries: 2, capMs: 60_000 },
    );
    await assert.rejects(wrapped.messages.create({}));
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  test("stops once the total-wait cap would be exceeded", async () => {
    let calls = 0;
    const wrapped = withRetry429(
      client(async () => {
        calls++;
        throw anthropicRateLimitError("100"); // 100s per attempt
      }),
      { maxRetries: 10, capMs: 5_000 }, // cap smaller than one wait
    );
    await assert.rejects(wrapped.messages.create({}));
    assert.equal(calls, 1); // the very first retry's wait already exceeds the cap
  });
});

describe("withRetry429 — OpenAI-compat shim (ProviderHttpError)", () => {
  test("honors retryAfterMs then succeeds", async () => {
    let calls = 0;
    const wrapped = withRetry429(
      client(async () => {
        calls++;
        if (calls === 1) throw new ProviderHttpError(429, "rate limited", "rate limited", 5);
        return { ok: true };
      }),
    );
    const result = await wrapped.messages.create({});
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  });

  test("a non-429 ProviderHttpError is never retried", async () => {
    let calls = 0;
    const wrapped = withRetry429(
      client(async () => {
        calls++;
        throw new ProviderHttpError(500, "server error");
      }),
    );
    await assert.rejects(wrapped.messages.create({}));
    assert.equal(calls, 1);
  });
});

describe("withConcurrencyLimit", () => {
  test("caps simultaneous in-flight calls at the configured limit", async () => {
    let active = 0;
    let maxActive = 0;
    const wrapped = withConcurrencyLimit(
      client(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { ok: true };
      }),
      2,
    );

    await Promise.all([
      wrapped.messages.create({}),
      wrapped.messages.create({}),
      wrapped.messages.create({}),
      wrapped.messages.create({}),
    ]);
    assert.equal(maxActive <= 2, true);
  });

  test("undefined limit is a no-op (returns the same client, unlimited concurrency)", async () => {
    let active = 0;
    let maxActive = 0;
    const wrapped = withConcurrencyLimit(
      client(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { ok: true };
      }),
      undefined,
    );
    await Promise.all([wrapped.messages.create({}), wrapped.messages.create({}), wrapped.messages.create({})]);
    assert.equal(maxActive, 3);
  });

  test("a shared limiter state is enforced across separately-wrapped clients", async () => {
    const state = getSharedLimiter("test-shared-key-1", 1);
    let active = 0;
    let maxActive = 0;
    const makeClient = () =>
      withConcurrencyLimit(
        client(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
          return { ok: true };
        }),
        1,
        state,
      );
    await Promise.all([makeClient().messages.create({}), makeClient().messages.create({}), makeClient().messages.create({})]);
    assert.equal(maxActive, 1);
  });
});

describe("withRetry429 / withConcurrencyLimit — abort", () => {
  test("a cancelled call rejects with the abort reason instead of waiting out a 429 backoff", async () => {
    let calls = 0;
    const wrapped = withRetry429(
      client(async () => {
        calls++;
        throw anthropicRateLimitError("10"); // 10s wait, under the 60s cap — would hang the test if not aborted
      }),
    );
    const ac = new AbortController();
    const reason = new Error("cancelled");
    const promise = wrapped.messages.create({}, { signal: ac.signal });
    ac.abort(reason);
    await assert.rejects(promise, (err) => err === reason);
    assert.equal(calls, 1);
  });

  test("a cancelled call waiting in the concurrency queue rejects instead of waiting for a slot", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const wrapped = withConcurrencyLimit(
      client(async () => {
        await held;
        return { ok: true };
      }),
      1,
    );
    const first = wrapped.messages.create({}); // takes the only slot
    const ac = new AbortController();
    const reason = new Error("cancelled");
    const queued = wrapped.messages.create({}, { signal: ac.signal });
    ac.abort(reason);
    await assert.rejects(queued, (err) => err === reason);
    release();
    await first;
  });
});
