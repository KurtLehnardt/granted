import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextResponse } from "next/server";
import { withErrorLogging } from "../withErrorLogging";
import type { LogErrorOptions } from "../server";

function recorder() {
  const calls: Array<{ area: string; err: unknown; opts?: LogErrorOptions }> = [];
  const log = (area: string, err: unknown, opts?: LogErrorOptions) => {
    calls.push({ area, err, opts });
    return "E-TESTID";
  };
  return { calls, log };
}

const req = new Request("http://127.0.0.1:3000/api/match?x=1", { method: "POST" });

describe("withErrorLogging", () => {
  test("a thrown error: logged with the route, answered with a plain 500 carrying its id (no internals)", async () => {
    const { calls, log } = recorder();
    const origError = console.error;
    console.error = () => {};
    try {
      const handler = withErrorLogging("search", async (_r: Request): Promise<Response> => {
        throw new Error("ENOENT C:\\secret\\path");
      }, log);
      const res = await handler(req);
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.errorId, "E-TESTID");
      assert.doesNotMatch(body.error, /ENOENT|secret/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].area, "search");
      assert.equal(calls[0].opts?.path, "/api/match");
    } finally {
      console.error = origError;
    }
  });

  test("a 5xx JSON answer: logged with its message, and gets an errorId", async () => {
    const { calls, log } = recorder();
    const handler = withErrorLogging("app-update", async (_r: Request) => NextResponse.json({ error: "Couldn't start", started: false }, { status: 500 }), log);
    const res = await handler(req);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Couldn't start", started: false, errorId: "E-TESTID" });
    assert.equal(calls[0].err, "Couldn't start");
  });

  test("a 5xx that already carries an errorId isn't logged twice", async () => {
    const { calls, log } = recorder();
    const handler = withErrorLogging("x", async () => NextResponse.json({ error: "e", errorId: "E-AAAAAA" }, { status: 502 }), log);
    assert.deepEqual(await (await handler()).json(), { error: "e", errorId: "E-AAAAAA" });
    assert.equal(calls.length, 0);
  });

  test("a non-JSON 5xx is logged and passed through untouched", async () => {
    const { calls, log } = recorder();
    const handler = withErrorLogging("x", async () => new Response("bad gateway", { status: 502 }), log);
    const res = await handler();
    assert.equal(await res.text(), "bad gateway");
    assert.equal(calls.length, 1);
  });

  test("success and 4xx pass straight through, unlogged (streams untouched)", async () => {
    const { calls, log } = recorder();
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("line\n")), c.close()) });
    const ok = withErrorLogging("x", async () => new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } }), log);
    assert.equal(await (await ok()).text(), "line\n");
    const bad = withErrorLogging("x", async () => NextResponse.json({ error: "too short" }, { status: 400 }), log);
    assert.equal((await bad()).status, 400);
    assert.equal(calls.length, 0);
  });

  test("a logger that throws can't break the answer", async () => {
    const handler = withErrorLogging("x", async () => NextResponse.json({ error: "e" }, { status: 500 }), () => {
      throw new Error("log broke");
    });
    const res = await handler();
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "e" });
  });
});
