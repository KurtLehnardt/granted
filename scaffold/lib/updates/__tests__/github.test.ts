import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchRemoteCommit } from "../github";

function fakeFetch(impl: (url: string, init: any) => Promise<any>): typeof fetch {
  return impl as unknown as typeof fetch;
}

describe("fetchRemoteCommit", () => {
  test("200 success resolves {sha}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ sha: "abc123def456" }) })),
    );
    assert.deepEqual(result, { sha: "abc123def456" });
  });

  test("sends the exact commits URL and required headers", async () => {
    let capturedUrl: string | null = null;
    let capturedInit: any = null;
    await fetchRemoteCommit(
      fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return { ok: true, status: 200, json: async () => ({ sha: "x" }) };
      }),
    );
    assert.equal(capturedUrl, "https://api.github.com/repos/KurtLehnardt/granted/commits/main");
    assert.equal(capturedInit.headers["User-Agent"], "granted-update-check");
    assert.equal(capturedInit.headers["Accept"], "application/vnd.github+json");
    assert.ok(capturedInit.signal, "expected an AbortSignal (timeout) to be passed");
  });

  test("a 403 (rate-limited) non-ok response resolves {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    assert.deepEqual(result, { error: "GitHub returned 403" });
  });

  test("a 404 non-ok response resolves {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    assert.deepEqual(result, { error: "GitHub returned 404" });
  });

  test("a 5xx non-ok response resolves {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    assert.deepEqual(result, { error: "GitHub returned 503" });
  });

  test("a rejected fetch (network down) resolves {error}, never throws", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    assert.ok("error" in result);
  });

  test("an abort/timeout (TimeoutError) resolves a timeout-specific {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => {
        const e: any = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      }),
    );
    assert.deepEqual(result, { error: "Timed out contacting GitHub." });
  });

  test("malformed JSON body resolves {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })),
    );
    assert.deepEqual(result, { error: "Unexpected response from GitHub." });
  });

  test("a body missing .sha resolves {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ commit: { message: "hi" } }) })),
    );
    assert.deepEqual(result, { error: "Unexpected response from GitHub." });
  });

  test("a body with a non-string .sha resolves {error}", async () => {
    const result = await fetchRemoteCommit(
      fakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ sha: 12345 }) })),
    );
    assert.deepEqual(result, { error: "Unexpected response from GitHub." });
  });
});
